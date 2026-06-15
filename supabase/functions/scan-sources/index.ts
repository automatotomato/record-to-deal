// scan-sources worker: pulls RECORDED-DEED candidates for ONE county.
//
// Only runs for priority states defined in _shared/recorder-sources.ts.
// Uses Firecrawl site-scoped search against each county's official recorder /
// clerk / registry-of-deeds domains, then runs an AI extractor with a strict
// grantor/grantee/document_type schema. Any candidate whose source_record_url
// is NOT on a trusted recorder domain is rejected.
//
// Brokerage / MLS / Zillow / LoopNet / Crexi are explicitly forbidden — that
// data is what produced bad contacts in the past.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  RECORDER_REGISTRY,
  isPriorityState,
  getCountySource,
  trustedDomainsFor,
  urlIsTrusted,
  FORBIDDEN_DOMAINS,
} from "../_shared/recorder-sources.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FIRECRAWL_V2 = "https://api.firecrawl.dev/v2";
const AI_URL = "https://api.openai.com/v1/chat/completions";
const AI_MODEL = "gpt-4o-mini";
const MAX_RESULTS_PER_QUERY = 6;
const HARD_BUDGET_MS = 45_000;

type Candidate = {
  grantor_name?: string;
  grantee_name?: string;
  document_type?: string;
  recording_number?: string;
  recorded_date?: string;
  consideration_amount?: number;
  parcel_number?: string;
  legal_description?: string;
  property_address?: string;
  property_city?: string;
  property_zip?: string;
  source_record_url?: string;
};

const FORBIDDEN_QUERY_EXCLUSIONS = FORBIDDEN_DOMAINS.map((d) => `-site:${d}.com`).join(" ");

function deedQueriesFor(state: string, county: string): string[] {
  const cs = getCountySource(state, county);
  if (!cs) return [];
  // site-scoped queries against trusted recorder domains
  const sites = cs.domains.map((d) => `site:${d}`).join(" OR ");
  const deedTerms = `("warranty deed" OR "grant deed" OR "special warranty deed" OR "trustee's deed" OR "quitclaim deed" OR "grantor" "grantee")`;
  return [
    `(${sites}) ${deedTerms} "${county}"`,
    `(${sites}) "official records" OR "real property" "${county}"`,
  ];
}

function extractionHint(state: string, county: string): string {
  const cs = getCountySource(state, county);
  const portal = cs?.portalName ?? `${county} County Recorder`;
  return `These results are from the ${portal} (${state}). Extract ONLY records that are actual recorded deeds (warranty deed, grant deed, special warranty deed, trustee's deed, quitclaim deed). Use the grantor/grantee terminology — the grantee is the NEW owner we want to contact. Do NOT extract MLS listings, broker pages, Zillow, LoopNet, Crexi, CoStar, news articles, or property-transfers newspaper columns. If the page does not appear to be from an official county recorder/clerk/registry-of-deeds, return an empty leads array.`;
}

async function firecrawlSearch(
  query: string,
  apiKey: string,
  tbs: string,
): Promise<{ url: string; title: string; markdown: string }[]> {
  const r = await fetch(`${FIRECRAWL_V2}/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      limit: MAX_RESULTS_PER_QUERY,
      tbs,
      scrapeOptions: { onlyMainContent: true, formats: ["markdown"] },
    }),
  });
  if (!r.ok) throw new Error(`Firecrawl ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const results: any[] = (data?.data?.web as any[]) ?? (Array.isArray(data?.data) ? data.data : []) ?? [];
  return results.map((x) => ({
    url: String(x.url ?? ""),
    title: String(x.title ?? ""),
    markdown: String(x.markdown ?? x.description ?? ""),
  }));
}

async function aiExtractLeads(
  corpus: string,
  hint: string,
  openaiKey: string,
): Promise<Candidate[]> {
  const aiResp = await fetch(AI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: "system", content: "You extract recorded-deed transfers from official county recorder web pages. Never invent values. Skip refinancing, name-correction, or non-deed documents. Return ONLY valid JSON." },
        { role: "user", content: `${hint}

Return JSON: { "leads": [ {
  "grantor_name": string,
  "grantee_name": string,
  "document_type": "Warranty Deed" | "Grant Deed" | "Special Warranty Deed" | "Trustee's Deed" | "Quitclaim Deed",
  "recording_number": string|null,
  "recorded_date": "YYYY-MM-DD"|null,
  "consideration_amount": number|null,
  "parcel_number": string|null,
  "legal_description": string|null,
  "property_address": string|null,
  "property_city": string|null,
  "property_zip": string|null,
  "source_record_url": string
} ] }

If a result is clearly not a recorder/clerk/registry-of-deeds page, OR if grantor and grantee are the same party, OR if there is no document type, EXCLUDE it.

Web content:

${corpus.slice(0, 14000)}` },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!aiResp.ok) throw new Error(`AI ${aiResp.status}: ${(await aiResp.text()).slice(0, 200)}`);
  const aiData = await aiResp.json();
  const content = aiData?.choices?.[0]?.message?.content ?? "{}";
  let parsed: { leads?: Candidate[] } = {};
  try { parsed = JSON.parse(content); } catch { /* ignore */ }
  return Array.isArray(parsed.leads) ? parsed.leads : [];
}

function inferOwnerType(name?: string | null) {
  if (!name) return "Unknown";
  const n = name.toLowerCase();
  if (/\bllc\b|\bl\.l\.c\b/.test(n)) return "LLC";
  if (/\btrust\b|\btrustee\b/.test(n)) return "Trust";
  if (/\bcorp\b|\binc\b|\bcompany\b|\bco\.\b/.test(n)) return "Corporation";
  if (/\bestate of\b/.test(n)) return "Estate";
  return "Individual";
}

const norm = (s: string | null | undefined) =>
  (s ?? "").toString().trim().toUpperCase().replace(/\s+/g, " ").replace(/[.,]/g, "");

function cleanDate(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : s;
}

function sameParty(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return norm(a) === norm(b);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!firecrawlKey || !openaiKey) {
    return new Response(JSON.stringify({ error: "FIRECRAWL_API_KEY or OPENAI_API_KEY missing" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: { job_id?: string } = {};
  try { body = await req.json(); } catch (_) {}
  const jobId = body.job_id;
  if (!jobId) {
    return new Response(JSON.stringify({ error: "job_id required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data: job } = await supabase.from("pipeline_jobs").select("*").eq("id", jobId).maybeSingle();
  if (!job) {
    return new Response(JSON.stringify({ error: "job not found" }), {
      status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const countyId = job.county_id ?? job.payload?.county_id;
  if (!countyId) {
    await markFailed(supabase, jobId, "no county_id in job");
    return jsonOk({ ok: false, error: "no county_id" });
  }

  const { data: county } = await supabase.from("counties").select("*").eq("id", countyId).maybeSingle();
  if (!county) {
    await markFailed(supabase, jobId, "county not found");
    return jsonOk({ ok: false, error: "county missing" });
  }

  // ---- Priority-state gate ----
  if (!isPriorityState(county.state)) {
    await supabase.from("pipeline_jobs").update({
      status: "done",
      finished_at: new Date().toISOString(),
      result: {
        skipped: true,
        reason: `state ${county.state} not in priority list — recorder template not configured`,
      },
    }).eq("id", jobId);
    await supabase.from("counties").update({ last_run_at: new Date().toISOString() }).eq("id", county.id);
    return jsonOk({ ok: true, skipped: true, reason: "non_priority_state" });
  }

  const countySource = getCountySource(county.state, county.county);
  if (!countySource) {
    await supabase.from("pipeline_jobs").update({
      status: "done",
      finished_at: new Date().toISOString(),
      result: {
        skipped: true,
        reason: `county ${county.county}, ${county.state} not yet in recorder registry`,
      },
    }).eq("id", jobId);
    await supabase.from("counties").update({ last_run_at: new Date().toISOString() }).eq("id", county.id);
    return jsonOk({ ok: true, skipped: true, reason: "no_recorder_template" });
  }

  const start = Date.now();
  const errors: string[] = [];
  const allCandidates: Candidate[] = [];
  const queries = deedQueriesFor(county.state, county.county);
  const hint = extractionHint(county.state, county.county);
  // Rolling window: month first, fall back to quarter if no results.
  const tbsAttempts = county.last_run_at ? ["qdr:w", "qdr:m"] : ["qdr:m", "qdr:y"];

  for (const tbs of tbsAttempts) {
    for (const q of queries) {
      if (Date.now() - start > HARD_BUDGET_MS) { errors.push("time budget hit"); break; }
      try {
        const results = await firecrawlSearch(`${q} ${FORBIDDEN_QUERY_EXCLUSIONS}`, firecrawlKey, tbs);
        // Pre-filter to trusted recorder URLs only
        const trustedResults = results.filter((r) => urlIsTrusted(r.url, county.state, county.county));
        if (trustedResults.length === 0) continue;
        const corpus = trustedResults
          .map((r) => `### ${r.title}\nURL: ${r.url}\n\n${r.markdown.slice(0, 3500)}`)
          .join("\n\n---\n\n");
        const leads = await aiExtractLeads(corpus, hint, openaiKey);
        for (const l of leads) {
          if (!l.source_record_url && trustedResults[0]) l.source_record_url = trustedResults[0].url;
          allCandidates.push(l);
        }
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (allCandidates.length > 0) break;
  }

  // Validate + dedupe
  const seen = new Set<string>();
  const fresh: Candidate[] = [];
  for (const c of allCandidates) {
    if (!c.grantee_name || !c.document_type) continue;
    if (sameParty(c.grantor_name, c.grantee_name)) continue; // refi / name correction
    if (!urlIsTrusted(c.source_record_url, county.state, county.county)) continue;
    const k = `${norm(c.recording_number)}|${norm(c.parcel_number)}|${norm(c.grantee_name)}|${norm(c.property_address)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push(c);
  }

  // Insert leads + enqueue verification
  let inserted = 0;
  let enqueued = 0;
  for (const c of fresh) {
    const ownerType = inferOwnerType(c.grantee_name);

    const { data: leadRow, error: insErr } = await supabase
      .from("leads")
      .insert({
        county_id: county.id,
        state: county.state,
        county: county.county,
        owner_name: c.grantee_name ?? null,
        owner_type: ownerType,
        prior_owner_name: c.grantor_name ?? null,
        document_type: c.document_type ?? null,
        recording_number: c.recording_number ?? null,
        deed_source_url: c.source_record_url ?? null,
        property_address: c.property_address ?? null,
        property_city: c.property_city ?? null,
        property_zip: c.property_zip ?? null,
        parcel_number: c.parcel_number ?? null,
        property_type: "Unknown",
        sale_price: c.consideration_amount ?? null,
        sale_date: cleanDate(c.recorded_date),
        deed_date: cleanDate(c.recorded_date),
        trigger_event: "deed_recorded",
        source_record_url: c.source_record_url ?? null,
        data_sources: ["firecrawl:recorder"],
        scout_confidence: 70,
        pipeline_stage: "raw_candidate",
        unmask_status: ownerType !== "Individual" ? "pending" : "unmasked",
      })
      .select("id")
      .single();

    if (insErr) {
      console.warn("insert lead failed:", insErr.message);
      continue;
    }
    inserted += 1;

    await supabase.from("lead_activities").insert({
      lead_id: leadRow.id,
      kind: "scout_found",
      summary: `Recorded ${c.document_type} in ${county.county}, ${county.state} (grantor: ${c.grantor_name ?? "unknown"} → grantee: ${c.grantee_name})`,
      payload: { source_url: c.source_record_url ?? null, recording_number: c.recording_number ?? null, job_id: jobId },
    });

    await supabase.from("pipeline_jobs").insert({
      kind: "verify_property",
      lead_id: leadRow.id,
      priority: 100,
    });
    enqueued += 1;
  }

  await supabase.from("counties").update({ last_run_at: new Date().toISOString() }).eq("id", county.id);

  await supabase.from("pipeline_jobs").update({
    status: "done",
    finished_at: new Date().toISOString(),
    result: {
      found: fresh.length,
      inserted,
      enqueued,
      portal: countySource.portalName,
      errors: errors.slice(0, 3),
    },
  }).eq("id", jobId);

  return jsonOk({
    ok: true,
    county: county.county,
    portal: countySource.portalName,
    found: fresh.length,
    inserted,
    enqueued,
    errors,
  });
});

function jsonOk(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function markFailed(supabase: any, jobId: string, msg: string) {
  await supabase.from("pipeline_jobs").update({
    status: "failed",
    finished_at: new Date().toISOString(),
    last_error: msg,
  }).eq("id", jobId);
}
