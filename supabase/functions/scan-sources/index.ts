// scan-sources worker: pulls raw candidate sales for ONE county.
//
// Strategy: recorder-deed-first. We bias every query toward the county's
// public recorder/clerk deed index and government domains; we explicitly
// deny-list broker/MLS/listing portals so the "owner" we extract is the
// GRANTOR on the recorded deed (the real seller), never a listing agent.
//
// Job kind: scan_sources. Strictly time-budgeted (≤45s).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FIRECRAWL_V2 = "https://api.firecrawl.dev/v2";
const AI_URL = "https://api.openai.com/v1/chat/completions";
const AI_MODEL = "gpt-4o-mini";
const MAX_RESULTS_PER_QUERY = 3;
const HARD_BUDGET_MS = 45_000;
const MIN_SALE_PRICE = 500_000;
const MIN_CONFIDENCE = 70;
// Tokens that signal we're looking at an actual recorded-deed index/page,
// not a listing, news article, or press release.
const DEED_LANGUAGE_RE = /\b(grantor|grantee|warranty deed|grant deed|quitclaim|special warranty|trustee'?s deed|deed of trust|book\s*\/?\s*page|instrument\s*(no|number|#)|recording date|recorded date|doc(ument)?\s*(no|number|#))\b/i;
const ALLOWED_PROPERTY_TYPES = new Set(["Multifamily", "Commercial", "Industrial", "Mixed", "Land"]);

type FirecrawlCredential = { label: string; key: string };

function firecrawlCredentials(): FirecrawlCredential[] {
  const override = Deno.env.get("FIRECRAWL_API_KEY_OVERRIDE")?.trim();
  const connector = Deno.env.get("FIRECRAWL_API_KEY")?.trim();
  const creds = [
    override ? { label: "override", key: override } : null,
    connector ? { label: "connector", key: connector } : null,
  ].filter(Boolean) as FirecrawlCredential[];
  return creds.filter((cred, idx) => creds.findIndex((x) => x.key === cred.key) === idx);
}

type Candidate = {
  grantor_name?: string;     // seller — what we actually want
  grantee_name?: string;     // buyer
  owner_name?: string;       // alias, kept for legacy AI output
  property_address?: string;
  property_city?: string;
  property_zip?: string;
  parcel_number?: string;
  instrument_number?: string;
  sale_price?: number;
  sale_date?: string;
  deed_date?: string;
  property_type?: string;
  source_record_url?: string;
  trigger_event?: string;
  confidence?: number;       // self-reported 0-100; we reject < MIN_CONFIDENCE
};

// Hosts we never want as a source — these are listing/broker/MLS portals
// where the "seller" is almost always a listing agent, not the deed grantor.
const BROKER_DENY_HOSTS = [
  "zillow.com", "trulia.com", "realtor.com", "redfin.com", "auction.com",
  "movoto.com", "homes.com", "loopnet.com", "crexi.com", "ten-x.com",
  "compass.com", "kw.com", "cbre.com", "jll.com", "marcusmillichap.com",
  "colliers.com", "cushmanwakefield.com", "berkshirehathawayhs.com",
  "century21.com", "remax.com", "coldwellbanker.com", "sothebysrealty.com",
  "douglaselliman.com", "corcoran.com", "exprealty.com", "har.com",
  "showmls.com", "har.com", "stellarmls.com", "mlslistings.com",
];
const BROKER_DENY_RE = new RegExp(
  "\\b(" + BROKER_DENY_HOSTS.map((h) => h.replace(/\./g, "\\.")).join("|") + ")\\b",
  "i",
);
const NEG_SITE_FILTER = BROKER_DENY_HOSTS.map((h) => `-site:${h}`).join(" ");

function hostOf(url?: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

function isBrokerUrl(url?: string | null): boolean {
  const h = hostOf(url);
  if (!h) return false;
  return BROKER_DENY_RE.test(h);
}

function buildQueries(_state: string, _county: string, recorderUrl: string | null) {
  // Recorder-only sourcing. If we don't have a recorder index URL for this
  // county, we produce ZERO queries — county stays parked rather than
  // pulling noise from listings/news/aggregators.
  const recorderHost = hostOf(recorderUrl);
  if (!recorderHost) return [];
  return [
    `site:${recorderHost} (deed OR "warranty deed" OR "grant deed" OR "special warranty" OR "deed of trust") grantor grantee`,
  ];
}

function defaultHint(state: string, county: string) {
  return `${county} County, ${state} RECORDED DEED data extraction.

PRIMARY GOAL: extract the GRANTOR (the seller on the recorded deed). The grantor is the actual property seller — the person or entity we want to contact. The grantee is the buyer.

STRICT RULES — if the source page is not a recorded-deed index entry, a deed image, or an official records search result, return { "leads": [] }. Do NOT infer grantors from listings, MLS pages, news articles, broker pages, or press releases.

Every record MUST have ALL of: grantor_name, property_address, parcel_number (APN), instrument_number (or recording number/document number), recording or deed date, and sale_price ≥ $${MIN_SALE_PRICE.toLocaleString()}.

Property type MUST be one of: Multifamily, Commercial, Industrial, Mixed, Land. EXCLUDE single-family homes, condos, townhomes, owner-occupied residences. Prefer LLC/Trust/Corp grantors.

For each record also self-report a confidence score 0-100 reflecting how clearly this is a real recorded deed with verifiable fields. Anything below ${MIN_CONFIDENCE} will be discarded.`;
}

const FC_ADMIN = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
async function fcReserve(caller: string, credits: number): Promise<string | null> {
  try { const { data } = await FC_ADMIN.rpc("fc_reserve", { p_caller: caller, p_credits: credits }); return (data as string) ?? null; }
  catch (e) { console.warn("fc_reserve threw", e); return null; }
}
async function fcRelease(id: string | null, actual: number, status = "done") {
  if (!id) return;
  try { await FC_ADMIN.rpc("fc_release", { p_id: id, p_actual: actual, p_status: status }); } catch (_) {}
}

async function firecrawlSearch(
  query: string,
  credentials: FirecrawlCredential[],
  tbs: string,
): Promise<{ url: string; title: string; markdown: string }[]> {
  const cost = MAX_RESULTS_PER_QUERY * 2; // search + scrape per result
  const resId = await fcReserve("scan-sources:search", cost);
  if (!resId) { console.warn("fc_throttled scan-sources search"); return []; }
  try {
    let lastError = "Firecrawl credentials unavailable";
    for (const cred of credentials) {
      const r = await fetch(`${FIRECRAWL_V2}/search`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cred.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          limit: MAX_RESULTS_PER_QUERY,
          tbs,
          scrapeOptions: { onlyMainContent: true, formats: ["markdown"] },
        }),
      });
      if (!r.ok) {
        lastError = `Firecrawl ${r.status} (${cred.label}): ${(await r.text()).slice(0, 200)}`;
        if ([401, 402, 403].includes(r.status) && credentials.length > 1) continue;
        throw new Error(lastError);
      }
      const data = await r.json();
      await fcRelease(resId, cost, "done");
      const results: any[] = (data?.data?.web as any[]) ?? (data?.web as any[]) ?? (Array.isArray(data?.data) ? data.data : []) ?? [];
      return results
        .map((x) => ({
          url: String(x.url ?? ""),
          title: String(x.title ?? ""),
          markdown: String(x.markdown ?? x.description ?? ""),
        }))
        .filter((r) => !isBrokerUrl(r.url))
        .filter((r) => {
          const resultHost = hostOf(r.url);
          const queryHost = query.match(/site:([^\s]+)/)?.[1]?.replace(/^www\./, "");
          return !!queryHost && resultHost === queryHost || DEED_LANGUAGE_RE.test(`${r.title}\n${r.markdown}`);
        });
    }
    throw new Error(lastError);
  } catch (e) { await fcRelease(resId, cost, "failed"); throw e; }
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
        { role: "system", content: "You extract recorded-deed (grantor → grantee) property-transfer records from web content. Return ONLY valid JSON. If the source is not a recorded-deed index entry or deed image, return { \"leads\": [] }. Never invent fields — leave them out rather than guess. Skip records missing an address, parcel, instrument number, or grantor name." },
        { role: "user", content: `${hint}\n\nReturn JSON: { "leads": [ { grantor_name (seller), grantee_name (buyer), owner_name (= grantor_name), property_address, property_city, property_zip, parcel_number, instrument_number, sale_price (number), sale_date (YYYY-MM-DD), deed_date (YYYY-MM-DD), property_type (one of Multifamily|Commercial|Industrial|Mixed|Land), source_record_url, trigger_event (one of recent_sale|listed_for_sale|long_hold_owner|trust_transfer|off_market_signal), confidence (0-100 self-reported) } ] }\n\nWeb content:\n\n${corpus.slice(0, 14000)}` },
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
  const firecrawlCreds = firecrawlCredentials();
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!firecrawlCreds.length || !openaiKey) {
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

  // Cooldown: skip if this county was scanned within the last 12 hours
  // (manual button + cron + dispatcher retries can otherwise stack up).
  const force = !!(job.payload as any)?.force;
  if (!force && county.last_run_at && (Date.now() - new Date(county.last_run_at).getTime()) < 12 * 60 * 60 * 1000) {
    await supabase.from("pipeline_jobs").update({
      status: "done", finished_at: new Date().toISOString(),
      result: { skipped: "cooldown_12h", last_run_at: county.last_run_at },
    }).eq("id", jobId);
    return jsonOk({ ok: true, skipped: "cooldown_12h", county: county.county });
  }

  const start = Date.now();
  const errors: string[] = [];
  const allCandidates: Candidate[] = [];
  const queries = buildQueries(county.state, county.county, county.recorder_index_url);
  const drops = { no_recorder_url: 0, page_rejected: 0, confidence_too_low: 0, under_price_floor: 0, wrong_property_type: 0, missing_required_fields: 0, broker_source: 0 };

  if (queries.length === 0) {
    drops.no_recorder_url = 1;
    await supabase.from("counties").update({ last_run_at: new Date().toISOString() }).eq("id", county.id);
    await supabase.from("pipeline_jobs").update({
      status: "done",
      finished_at: new Date().toISOString(),
      result: { found: 0, inserted: 0, enqueued: 0, drops, note: "county has no recorder_index_url — parked" },
    }).eq("id", jobId);
    return jsonOk({ ok: true, county: county.county, found: 0, inserted: 0, enqueued: 0, drops });
  }

  const hint = defaultHint(county.state, county.county);
  const tbs = county.last_run_at ? "qdr:w" : "qdr:m";

  for (const q of queries) {
    if (Date.now() - start > HARD_BUDGET_MS) { errors.push("time budget hit"); break; }
    try {
      const results = await firecrawlSearch(q, firecrawlCreds, tbs);
      if (!results.length) { drops.page_rejected += 1; continue; }
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

  // Dedupe + hard filters. Anything missing required fields gets dropped
  // with a reason recorded for the Sources page.
  const seen = new Set<string>();
  const fresh: Candidate[] = [];
  for (const c of allCandidates) {
    if (isBrokerUrl(c.source_record_url)) { drops.broker_source += 1; continue; }
    const sellerName = c.grantor_name ?? c.owner_name;
    if (!sellerName || !c.property_address || !c.parcel_number || !c.instrument_number) {
      drops.missing_required_fields += 1; continue;
    }
    if (typeof c.confidence === "number" && c.confidence < MIN_CONFIDENCE) {
      drops.confidence_too_low += 1; continue;
    }
    if (!c.sale_price || c.sale_price < MIN_SALE_PRICE) {
      drops.under_price_floor += 1; continue;
    }
    const mappedType = mapPropertyType(c.property_type);
    if (!ALLOWED_PROPERTY_TYPES.has(mappedType)) {
      drops.wrong_property_type += 1; continue;
    }
    const k = `${norm(c.parcel_number)}|${norm(c.instrument_number)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    c.owner_name = sellerName;
    c.grantor_name = sellerName;
    c.property_type = mappedType;
    fresh.push(c);
  }

  let inserted = 0;
  let enqueued = 0;
  for (const c of fresh) {
    const ownerType = inferOwnerType(c.owner_name);
    const propertyType = c.property_type ?? "Unknown";
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
        data_sources: ["firecrawl:recorder"],
        scout_confidence: typeof c.confidence === "number" ? Math.min(100, c.confidence) : 75,
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
      summary: `Discovered via recorder-deed search in ${county.county}, ${county.state}` +
        (c.grantee_name ? ` (grantee: ${c.grantee_name})` : "") +
        (c.instrument_number ? ` · Inst #${c.instrument_number}` : ""),
      payload: {
        source_url: c.source_record_url ?? null,
        job_id: jobId,
        grantor_name: c.grantor_name ?? null,
        grantee_name: c.grantee_name ?? null,
        instrument_number: c.instrument_number ?? null,
        confidence: c.confidence ?? null,
      },
    });

    if (stage === "raw_candidate") {
      await supabase.from("pipeline_jobs").insert({
        kind: "verify_property",
        lead_id: leadRow.id,
        priority: 100,
      });
      enqueued += 1;
    }
  }

  const credentialBlocked = inserted === 0 && errors.some((e) => /Firecrawl\s+(401|402|403)/i.test(e));
  if (credentialBlocked) {
    await markFailed(supabase, jobId, errors[0] ?? "Firecrawl credential failed");
    await supabase.from("pipeline_jobs").update({
      result: { found: fresh.length, inserted, enqueued, drops, recorder_url: county.recorder_index_url, errors: errors.slice(0, 3) },
    }).eq("id", jobId);
    return jsonOk({ ok: false, county: county.county, found: fresh.length, inserted, enqueued, drops, errors });
  }

  await supabase.from("counties").update({ last_run_at: new Date().toISOString() }).eq("id", county.id);

  await supabase.from("pipeline_jobs").update({
    status: "done",
    finished_at: new Date().toISOString(),
    result: { found: fresh.length, inserted, enqueued, drops, recorder_url: county.recorder_index_url, errors: errors.slice(0, 3) },
  }).eq("id", jobId);

  return jsonOk({ ok: true, county: county.county, found: fresh.length, inserted, enqueued, drops, errors });
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
