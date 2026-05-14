// scan-external-sources worker: discovers candidate 1031 leads from sources
// OUTSIDE the county recorder pipeline. Uses Gemini (Lovable AI Gateway) with
// Google Search grounding to surface fresh listings + filings, then inserts
// candidate leads that flow through the same verify_property → qualify_lead →
// enrich_contact chain as county-sourced leads.
//
// Source families (per user-selected scope):
//   - commercial : Crexi + LoopNet recently sold
//   - residential: Redfin recently sold (investment-grade only)
//   - court      : probate, tax-lien, divorce property dispositions
//   - sec        : SEC EDGAR 8-K real-estate dispositions by entity sellers
//
// Job kind: scan_external. Payload: { state: "TX", source: "commercial" }.
// Special bootstrap mode: { enqueue: true } — fans out one job per
// (enabled-state × source) and returns. Used by the cron schedule.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const AI_URL = "https://api.openai.com/v1/chat/completions";
const AI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-5.1";
const FC_V2 = "https://api.firecrawl.dev/v2";

if (!(globalThis as any).__sesLogged) {
  console.log(`[scan-external-sources] OpenAI model: ${AI_MODEL}`);
  (globalThis as any).__sesLogged = true;
}

function searchQueriesFor(source: SourceKind, state: string, counties: string[]): string[] {
  const top = counties.slice(0, 3).join(" OR ");
  switch (source) {
    case "commercial":
      return [
        `site:crexi.com sold ${state} commercial multifamily 2025 ${top}`,
        `site:loopnet.com sold ${state} ${top} 2025`,
      ];
    case "residential":
      return [
        `site:redfin.com sold ${state} ${top} multifamily 2025`,
        `site:redfin.com sold ${state} duplex triplex 2025`,
      ];
    case "court":
      return [
        `${state} probate sale notice ${top} 2025`,
        `${state} tax lien auction property 2025 ${top}`,
      ];
    case "sec":
      return [
        `site:sec.gov 8-K disposition real estate ${state} 2025`,
        `site:sec.gov 8-K sold property ${state}`,
      ];
  }
}

async function firecrawlSearch(query: string, fcKey: string, limit = 6): Promise<Array<{ url?: string; title?: string; markdown?: string; description?: string }>> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(`${FC_V2}/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query, limit,
        scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      console.warn(`firecrawl ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return [];
    }
    const d = await r.json();
    const arr = d?.data?.web ?? d?.data ?? d?.web ?? [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { console.warn("firecrawl threw", e); return []; }
  finally { clearTimeout(tid); }
}

async function extractFromEvidence(
  source: SourceKind,
  state: string,
  evidence: string,
  apiKey: string,
): Promise<Candidate[]> {
  const sys = `You extract real-estate transactions from scraped web evidence into structured JSON. Use ONLY facts present in the evidence. Never invent emails, phones, or owner names. Return an empty list when nothing usable is present.`;
  const user = `Source family: ${source}. State: ${state}.

Extract up to 12 distinct candidate 1031 leads from the evidence below. Each lead requires owner_name, property_address, and source_record_url, plus at least ONE reachability field (owner_contact_email, owner_contact_phone, or owner_website).

Return ONLY:
{
  "leads": [
    {
      "owner_name": "string",
      "owner_contact_name": "string|null",
      "owner_contact_email": "string|null",
      "owner_contact_phone": "string|null",
      "owner_website": "string|null",
      "property_address": "string",
      "property_city": "string|null",
      "property_zip": "string|null",
      "sale_price": number|null,
      "sale_date": "YYYY-MM-DD"|null,
      "property_type": "SFR|Multifamily|Commercial|Industrial|Land|Mixed|Unknown",
      "trigger_event": "recent_sale|probate|tax_lien|divorce|sec_disposition",
      "source_record_url": "string"
    }
  ]
}

EVIDENCE:
${evidence.slice(0, 28000)}`;

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(AI_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [{ role: "system", content: sys }, { role: "user", content: user }],
        response_format: { type: "json_object" },
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const txt = (await r.text()).slice(0, 300);
      console.warn(`openai ${r.status}: ${txt}`);
      return [];
    }
    const data = await r.json();
    const raw = data?.choices?.[0]?.message?.content ?? "{}";
    const cleaned = String(raw).replace(/^```json\s*|\s*```$/g, "").trim();
    let parsed: { leads?: Candidate[] } = {};
    try { parsed = JSON.parse(cleaned); } catch { /* ignore */ }
    return Array.isArray(parsed.leads) ? parsed.leads.slice(0, 12) : [];
  } finally { clearTimeout(tid); }
}

async function webGroundedExtract(
  source: SourceKind,
  state: string,
  counties: string[],
  fcKey: string,
  aiKey: string,
): Promise<Candidate[]> {
  const queries = searchQueriesFor(source, state, counties);
  const evidenceParts: string[] = [];
  for (const q of queries) {
    const results = await firecrawlSearch(q, fcKey, 6);
    for (const r of results) {
      const chunk = `URL: ${r.url ?? ""}\nTITLE: ${r.title ?? ""}\n${(r.markdown ?? r.description ?? "").slice(0, 4000)}`;
      evidenceParts.push(chunk);
    }
  }
  if (!evidenceParts.length) return [];
  return extractFromEvidence(source, state, evidenceParts.join("\n---\n"), aiKey);
}

function inferOwnerType(name?: string | null) {
  if (!name) return "Unknown";
  const n = name.toLowerCase();
  if (/\bllc\b|\bl\.l\.c\b/.test(n)) return "LLC";
  if (/\btrust\b|\btrustee\b/.test(n)) return "Trust";
  if (/\bcorp\b|\binc\b|\bcompany\b|\bco\.\b|\breit\b/.test(n)) return "Corporation";
  if (/\bestate of\b/.test(n)) return "Estate";
  return "Individual";
}

function isUnlockedEmail(e?: string | null): boolean {
  if (!e) return false;
  if (!/[^@\s]+@[^@\s]+\.[a-z]{2,}/i.test(e)) return false;
  return !/email_not_unlocked|domain\.com$|@apollo-locked/i.test(e);
}

function hasUsablePhone(p?: string | null): boolean {
  return String(p ?? "").replace(/\D/g, "").length >= 10;
}

function normalizeWebsite(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.startsWith("http") ? value : `https://${value}`);
    return `https://${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}`;
  } catch { return null; }
}

function hasReachability(c: Candidate): boolean {
  return isUnlockedEmail(c.owner_contact_email) || hasUsablePhone(c.owner_contact_phone) || !!normalizeWebsite(c.owner_website);
}

function mapPropertyType(raw?: string): string {
  const valid = ["SFR", "Multifamily", "Commercial", "Industrial", "Land", "Mixed", "Unknown"];
  if (raw && valid.includes(raw)) return raw;
  const l = (raw ?? "").toLowerCase();
  if (l.includes("indust") || l.includes("warehouse")) return "Industrial";
  if (l.includes("office") || l.includes("retail") || l.includes("nnn") || l.includes("commerc")) return "Commercial";
  if (l.includes("apart") || l.includes("multi") || l.includes("duplex") || l.includes("triplex") || l.includes("fourplex")) return "Multifamily";
  if (l.includes("single") || l.includes("residential") || l.includes("sfr")) return "SFR";
  if (l.includes("land") || l.includes("vacant")) return "Land";
  return "Unknown";
}

function mapTrigger(raw?: string): string {
  const map: Record<string, string> = {
    recent_sale: "sale_recorded",
    probate: "transfer_recorded",
    tax_lien: "transfer_recorded",
    divorce: "transfer_recorded",
    sec_disposition: "sale_recorded",
  };
  return map[raw ?? ""] ?? "sale_recorded";
}

const norm = (s: string | null | undefined) =>
  (s ?? "").toString().trim().toUpperCase().replace(/\s+/g, " ").replace(/[.,]/g, "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const lovableKey = Deno.env.get("OPENAI_API_KEY");

  let body: { job_id?: string; enqueue?: boolean } = {};
  try { body = await req.json(); } catch (_) {}

  // ---- Bootstrap mode: fan out one job per (state × source) ----
  if (body.enqueue) {
    const { data: counties } = await supabase
      .from("counties").select("state, county").eq("enabled", true);
    const byState = new Map<string, string[]>();
    for (const c of counties ?? []) {
      if (!byState.has(c.state)) byState.set(c.state, []);
      byState.get(c.state)!.push(c.county);
    }
    const rows: any[] = [];
    for (const [state] of byState) {
      for (const source of SOURCES) {
        rows.push({
          kind: "scan_external",
          payload: { state, source },
          priority: source === "commercial" ? 90 : 110,
        });
      }
    }
    if (rows.length) await supabase.from("pipeline_jobs").insert(rows);
    return jsonOk({ ok: true, enqueued: rows.length });
  }

  // ---- Worker mode: process one (state, source) job ----
  if (!body.job_id) return jsonErr("job_id or enqueue required", 400);
  if (!lovableKey) return jsonErr("OPENAI_API_KEY not configured", 500);

  const { data: job } = await supabase
    .from("pipeline_jobs").select("*").eq("id", body.job_id).maybeSingle();
  if (!job) return jsonErr("job not found", 404);

  const state: string | undefined = job.payload?.state;
  const source: SourceKind | undefined = job.payload?.source;
  if (!state || !source || !SOURCES.includes(source)) {
    await markFailed(supabase, body.job_id, "missing/invalid state or source");
    return jsonOk({ ok: false });
  }

  const { data: counties } = await supabase
    .from("counties").select("county").eq("state", state).eq("enabled", true);
  const countyNames = (counties ?? []).map((c) => c.county);
  if (!countyNames.length) {
    await supabase.from("pipeline_jobs").update({
      status: "done", finished_at: new Date().toISOString(),
      result: { skipped: "no enabled counties" },
    }).eq("id", body.job_id);
    return jsonOk({ ok: true, skipped: true });
  }

  const start = Date.now();
  const errors: string[] = [];
  let candidates: Candidate[] = [];
  try {
    candidates = await geminiGroundedExtract(promptFor(source, state, countyNames), lovableKey);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  // Dedupe + drop incomplete records.
  const seen = new Set<string>();
  const fresh: Candidate[] = [];
  for (const c of candidates) {
    if (!c.owner_name || !c.property_address || !c.source_record_url) continue;
    if (!hasReachability(c)) continue;
    const k = `${norm(c.property_address)}|${norm(c.owner_name)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push(c);
  }

  // Skip duplicates already in DB (same address + state).
  let inserted = 0;
  let enqueued = 0;
  for (const c of fresh) {
    if (Date.now() - start > HARD_BUDGET_MS) { errors.push("time budget hit"); break; }

    const { data: existing } = await supabase
      .from("leads").select("id")
      .eq("state", state)
      .ilike("property_address", c.property_address!)
      .limit(1).maybeSingle();
    if (existing) continue;

    const ownerType = inferOwnerType(c.owner_name);
    const propertyType = mapPropertyType(c.property_type);
    const triggerEvent = mapTrigger(c.trigger_event);
    const sourceTag = `gemini:${source}`;

    const { data: leadRow, error: insErr } = await supabase
      .from("leads")
      .insert({
        state,
        county: countyNames[0], // best-effort; verify_property may correct it
        owner_name: c.owner_name,
        owner_type: ownerType,
        property_address: c.property_address,
        property_city: c.property_city ?? null,
        property_zip: c.property_zip ?? null,
        decision_maker_name: c.owner_contact_name ?? null,
        decision_maker_email: isUnlockedEmail(c.owner_contact_email) ? c.owner_contact_email : null,
        decision_maker_phone: hasUsablePhone(c.owner_contact_phone) ? c.owner_contact_phone : null,
        contact_email: isUnlockedEmail(c.owner_contact_email) ? c.owner_contact_email : null,
        contact_phone: hasUsablePhone(c.owner_contact_phone) ? c.owner_contact_phone : null,
        company_website: normalizeWebsite(c.owner_website),
        has_contact: true,
        has_outreach_contact: true,
        property_type: propertyType,
        sale_price: c.sale_price ?? null,
        sale_date: c.sale_date ?? null,
        deed_date: c.sale_date ?? null,
        trigger_event: triggerEvent,
        source_record_url: c.source_record_url,
        data_sources: [sourceTag],
        scout_confidence: source === "sec" ? 70 : 55,
        pipeline_stage: "enriched",
      })
      .select("id").single();

    if (insErr) { console.warn("insert failed:", insErr.message); continue; }
    inserted += 1;

    await supabase.from("lead_activities").insert({
      lead_id: leadRow.id,
      kind: "scout_found",
      summary: `Discovered via Gemini scan (${source}) in ${state}`,
      payload: { source, source_url: c.source_record_url, job_id: body.job_id },
    });

    await supabase.from("pipeline_jobs").insert({
      kind: "verify_property", lead_id: leadRow.id, priority: 100,
    });
    enqueued += 1;
  }

  await supabase.from("pipeline_jobs").update({
    status: "done", finished_at: new Date().toISOString(),
    result: { state, source, found: fresh.length, inserted, enqueued, errors: errors.slice(0, 3) },
  }).eq("id", body.job_id);

  return jsonOk({ ok: true, state, source, found: fresh.length, inserted, enqueued, errors });
});

function jsonOk(b: unknown) {
  return new Response(JSON.stringify(b), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function jsonErr(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
async function markFailed(supabase: any, jobId: string, msg: string) {
  await supabase.from("pipeline_jobs").update({
    status: "failed", finished_at: new Date().toISOString(), last_error: msg,
  }).eq("id", jobId);
}
