// scan-sources worker: pulls raw candidate sales for ONE county via Firecrawl
// search + AI extraction, dedupes, and enqueues a verify_property job per
// candidate. Strictly time-budgeted (≤25 search results, ≤45s) so it never
// times out. Job kind: scan_sources.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FIRECRAWL_V2 = "https://api.firecrawl.dev/v2";
const AI_URL = "https://api.openai.com/v1/chat/completions";
const AI_MODEL = "gpt-4o-mini";
const MAX_QUERIES_PER_RUN = 2;
const MAX_RESULTS_PER_QUERY = 4;
const HARD_BUDGET_MS = 45_000;

type Candidate = {
  owner_name?: string;
  property_address?: string;
  property_city?: string;
  property_zip?: string;
  parcel_number?: string;
  sale_price?: number;
  sale_date?: string;
  deed_date?: string;
  property_type?: string;
  source_record_url?: string;
  trigger_event?: string;
};

const NV_EXCLUSIONS =
  "-site:zillow.com -site:trulia.com -site:realtor.com -site:redfin.com -site:auction.com -site:movoto.com -site:homes.com";

function defaultQueries(state: string, county: string) {
  return [
    `${county} County ${state} commercial OR multifamily OR industrial sold "$" LLC 2026 ${NV_EXCLUSIONS}`,
    `site:loopnet.com ${county} ${state} sold`,
  ];
}

function defaultHint(state: string, county: string) {
  return `${county} County, ${state} entity-owned multifamily ≥4-units, commercial, industrial, retail, NNN, office transfers. Skip SFR/condo and owner-occupied homes. Extract owner name, address, sale price (≥$500k), sale/deed date.`;
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
        { role: "system", content: "You extract structured property-transfer leads from web content. Return ONLY valid JSON. Skip records without an address or owner name." },
        { role: "user", content: `${hint}\n\nReturn JSON: { "leads": [ { owner_name, property_address, property_city, property_zip, parcel_number, sale_price (number), sale_date (YYYY-MM-DD), deed_date (YYYY-MM-DD), property_type (one of SFR|Multifamily|Commercial|Land|Industrial|Mixed|Unknown), source_record_url, trigger_event (one of recent_sale|listed_for_sale|long_hold_owner|trust_transfer|off_market_signal) } ] }\n\nWeb content:\n\n${corpus.slice(0, 14000)}` },
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

function mapPropertyType(raw: string | undefined): string {
  if (!raw) return "Unknown";
  const valid = ["SFR", "Multifamily", "Commercial", "Land", "Mixed", "Unknown"];
  if (valid.includes(raw)) return raw;
  const l = raw.toLowerCase();
  if (l.includes("indust") || l.includes("office") || l.includes("retail") || l.includes("warehouse")) return "Commercial";
  if (l.includes("apart") || l.includes("multi") || l.includes("duplex") || l.includes("triplex")) return "Multifamily";
  if (l.includes("single") || l.includes("residential") || l.includes("sfr") || l.includes("condo")) return "SFR";
  if (l.includes("land") || l.includes("vacant")) return "Land";
  return "Unknown";
}

function mapTrigger(raw: string | undefined): string {
  const map: Record<string, string> = {
    recent_sale: "sale_recorded",
    listed_for_sale: "commercial_listing",
    long_hold_owner: "listing_aged",
    trust_transfer: "transfer_recorded",
    off_market_signal: "pending_sale",
  };
  return map[raw ?? ""] ?? "sale_recorded";
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

  const start = Date.now();
  const errors: string[] = [];
  const allCandidates: Candidate[] = [];
  const queries = defaultQueries(county.state, county.county).slice(0, MAX_QUERIES_PER_RUN);
  const hint = defaultHint(county.state, county.county);
  const tbs = county.last_run_at ? "qdr:w" : "qdr:m";

  for (const q of queries) {
    if (Date.now() - start > HARD_BUDGET_MS) { errors.push("time budget hit"); break; }
    try {
      const results = await firecrawlSearch(q, firecrawlKey, tbs);
      const corpus = results
        .map((r) => `### ${r.title}\nURL: ${r.url}\n\n${r.markdown.slice(0, 3500)}`)
        .join("\n\n---\n\n");
      if (!corpus) continue;
      const leads = await aiExtractLeads(corpus, hint, openaiKey);
      for (const l of leads) {
        if (!l.source_record_url && results[0]) l.source_record_url = results[0].url;
        allCandidates.push(l);
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  // Dedupe within batch + against existing leads in the same county.
  const seen = new Set<string>();
  const fresh: Candidate[] = [];
  for (const c of allCandidates) {
    if (!c.property_address && !c.parcel_number) continue;
    const k = `${norm(c.parcel_number)}|${norm(c.property_address)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push(c);
  }

  // Insert raw_candidate leads. verify-property handles dedup vs existing.
  let inserted = 0;
  let enqueued = 0;
  for (const c of fresh) {
    const ownerType = inferOwnerType(c.owner_name);
    const propertyType = mapPropertyType(c.property_type);
    const triggerEvent = mapTrigger(c.trigger_event);
    const stage = triggerEvent === "commercial_listing" ? "pre_sale_prospect" : "raw_candidate";

    const { data: leadRow, error: insErr } = await supabase
      .from("leads")
      .insert({
        county_id: county.id,
        state: county.state,
        county: county.county,
        owner_name: c.owner_name ?? null,
        owner_type: ownerType,
        property_address: c.property_address ?? null,
        property_city: c.property_city ?? null,
        property_zip: c.property_zip ?? null,
        parcel_number: c.parcel_number ?? null,
        property_type: propertyType,
        sale_price: c.sale_price ?? null,
        sale_date: cleanDate(c.sale_date),
        deed_date: cleanDate(c.deed_date) ?? cleanDate(c.sale_date),
        trigger_event: triggerEvent,
        source_record_url: c.source_record_url ?? null,
        data_sources: ["firecrawl"],
        scout_confidence: 50,
        pipeline_stage: stage,
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
      summary: `Discovered via Firecrawl in ${county.county}, ${county.state}`,
      payload: { source_url: c.source_record_url ?? null, job_id: jobId },
    });

    // Only enqueue verification for actual sales. Pre-sale prospects stop here.
    if (stage === "raw_candidate") {
      await supabase.from("pipeline_jobs").insert({
        kind: "verify_property",
        lead_id: leadRow.id,
        priority: 100,
      });
      enqueued += 1;
    }
  }

  await supabase.from("counties").update({ last_run_at: new Date().toISOString() }).eq("id", county.id);

  await supabase.from("pipeline_jobs").update({
    status: "done",
    finished_at: new Date().toISOString(),
    result: { found: fresh.length, inserted, enqueued, errors: errors.slice(0, 3) },
  }).eq("id", jobId);

  return jsonOk({ ok: true, county: county.county, found: fresh.length, inserted, enqueued, errors });
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
