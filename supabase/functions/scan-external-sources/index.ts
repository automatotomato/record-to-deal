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

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const AI_MODEL = "google/gemini-3-flash-preview";
const HARD_BUDGET_MS = 50_000;

type SourceKind = "commercial" | "residential" | "court" | "sec";

type Candidate = {
  owner_name?: string;
  owner_contact_name?: string;
  owner_contact_email?: string;
  owner_contact_phone?: string;
  owner_website?: string;
  property_address?: string;
  property_city?: string;
  property_zip?: string;
  parcel_number?: string;
  sale_price?: number;
  sale_date?: string;
  property_type?: string;
  source_record_url?: string;
  trigger_event?: string;
};

const SOURCES: SourceKind[] = ["commercial", "residential", "court", "sec"];

const GATEWAY_HEADERS = (key: string) => ({
  "Lovable-API-Key": key,
  "X-Lovable-AIG-SDK": "vercel-ai-sdk",
  "Content-Type": "application/json",
});

function promptFor(source: SourceKind, state: string, counties: string[]): string {
  const countyList = counties.slice(0, 12).join(", ");
  const base = `You are a 1031-exchange deal scout. Use Google Search to find REAL, RECENT property transactions in ${state} (focus counties: ${countyList}). Only include transactions you can cite from a real URL — never fabricate. Return JSON only.`;

  const guidance: Record<SourceKind, string> = {
    commercial:
      `Search site:crexi.com and site:loopnet.com for recently SOLD commercial / multifamily / industrial / retail / NNN properties in ${state} in the last 60 days. Sale price ≥ $750k. Skip active listings. Skip residential.`,
    residential:
      `Search site:redfin.com for recently SOLD investment-grade residential in ${state} in the last 45 days: 2-4 unit multifamily, SFR rentals owned by an LLC/Trust/Corp, sale price ≥ $500k. Skip primary residences and skip anything where the buyer is an owner-occupant.`,
    court:
      `Search county court / clerk / recorder sites in ${state} for probate sales, tax-lien auctions, and divorce-driven property dispositions filed or scheduled in the last 60 days. These owners are forced sellers and prime 1031 candidates if they're swapping into other property. Include the case/filing URL.`,
    sec:
      `Search site:sec.gov for 8-K filings filed in the last 90 days disclosing the disposition / sale of real estate located in ${state}. Capture the seller entity (registrant), property address if disclosed, sale price, and filing URL.`,
  };

  return `${base}

${guidance[source]}

Return ONLY this JSON shape (max 12 leads):
{
  "leads": [
    {
      "owner_name": "string (seller / current owner — required)",
      "property_address": "string (street address — required)",
      "property_city": "string",
      "property_zip": "string",
      "sale_price": number,
      "sale_date": "YYYY-MM-DD",
      "property_type": "SFR|Multifamily|Commercial|Industrial|Land|Mixed|Unknown",
      "trigger_event": "recent_sale|probate|tax_lien|divorce|sec_disposition",
      "source_record_url": "string (the page you cited — required)"
    }
  ]
}

Skip any record missing owner_name, property_address, or source_record_url.`;
}

async function geminiGroundedExtract(
  prompt: string,
  apiKey: string,
): Promise<Candidate[]> {
  const r = await fetch(AI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: "system", content: "You return ONLY valid JSON. No prose, no markdown fences. Use Google Search to verify every transaction." },
        { role: "user", content: prompt },
      ],
      // Gemini-style grounding tool, passed through Lovable AI gateway.
      tools: [{ google_search: {} }],
    }),
  });
  if (!r.ok) {
    const txt = (await r.text()).slice(0, 300);
    throw new Error(`gemini ${r.status}: ${txt}`);
  }
  const data = await r.json();
  const raw = data?.choices?.[0]?.message?.content ?? "{}";
  // Strip ```json fences if the model adds them despite the system prompt.
  const cleaned = String(raw).replace(/^```json\s*|\s*```$/g, "").trim();
  let parsed: { leads?: Candidate[] } = {};
  try { parsed = JSON.parse(cleaned); } catch { /* ignore */ }
  return Array.isArray(parsed.leads) ? parsed.leads.slice(0, 12) : [];
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
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");

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
  if (!lovableKey) return jsonErr("LOVABLE_API_KEY not configured", 500);

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
        property_type: propertyType,
        sale_price: c.sale_price ?? null,
        sale_date: c.sale_date ?? null,
        deed_date: c.sale_date ?? null,
        trigger_event: triggerEvent,
        source_record_url: c.source_record_url,
        data_sources: [sourceTag],
        scout_confidence: source === "sec" ? 70 : 55,
        pipeline_stage: "raw_candidate",
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
