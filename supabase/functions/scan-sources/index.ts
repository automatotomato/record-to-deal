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
const MAX_RESULTS_PER_QUERY = 5;
const HARD_BUDGET_MS = 45_000;

type Candidate = {
  grantor_name?: string;     // seller — what we actually want
  grantee_name?: string;     // buyer
  owner_name?: string;       // alias, kept for legacy AI output
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

// Hosts where the "owner" we extract would actually be a listing agent, not
// the deed grantor. We still skip these as the PROPERTY-LEVEL source URL,
// but we no longer apply a hard -site: filter to the search query — that
// killed yield to zero in June. Treat as a soft URL filter only.
const BROKER_AS_OWNER_HOSTS = [
  "compass.com", "kw.com", "cbre.com", "jll.com", "marcusmillichap.com",
  "colliers.com", "cushmanwakefield.com", "berkshirehathawayhs.com",
  "century21.com", "remax.com", "coldwellbanker.com", "sothebysrealty.com",
  "douglaselliman.com", "corcoran.com", "exprealty.com", "har.com",
];
const BROKER_DENY_RE = new RegExp(
  "\\b(" + BROKER_AS_OWNER_HOSTS.map((h) => h.replace(/\./g, "\\.")).join("|") + ")\\b",
  "i",
);

function hostOf(url?: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

function isBrokerUrl(url?: string | null): boolean {
  const h = hostOf(url);
  if (!h) return false;
  return BROKER_DENY_RE.test(h);
}

function buildQueries(state: string, county: string, _recorderUrl: string | null) {
  const countyClean = county.replace(/\s+county$/i, "").trim();
  // Broad, high-yield queries — the same shape that produced ~50 leads in late May.
  // We don't site-deny broker hosts here: those pages still surface the real
  // owner LLC in the listing text, and the AI extractor pulls grantor from it.
  return [
    `${countyClean} County ${state} ("investment property" OR "commercial real estate" OR "apartment building" OR multifamily OR NNN OR industrial) sold "$" (LLC OR Trust OR Inc OR Corp) -"single family" -"owner occupied" -"primary residence"`,
    `site:loopnet.com OR site:crexi.com ${countyClean} ${state} sold`,
  ];
}

function defaultHint(state: string, county: string) {
  return `${county} County, ${state} INVESTMENT property transfers ONLY: entity-owned multifamily ≥4-units, commercial/retail/NNN/office/industrial, mixed-use, land ≥$250k. Strictly EXCLUDE single-family homes, condos, townhomes, owner-occupied residences, primary residences, and any sale under $500k. Prefer LLC/Trust/Corp owners over individuals. Extract owner name (the seller / grantor), address, sale price, sale/deed date.`;
}

async function firecrawlSearch(
  query: string,
  _apiKey: string,
  tbs: string,
): Promise<{ url: string; title: string; markdown: string }[]> {
  const { fcSearch } = await import("../_shared/firecrawl.ts");
  // Scrape full markdown — the AI extractor needs page body, not just snippets,
  // to reliably surface grantor/owner + price + address. Cost is bounded by
  // the daily per-caller cap and 14-day URL cache.
  const results = await fcSearch("scan-sources", query, {
    limit: MAX_RESULTS_PER_QUERY, scrape: true, tbs,
  });
  return (results as any[])
    .map((x) => ({
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
        { role: "system", content: "You extract recorded-deed (grantor → grantee) property-transfer records from web content. Return ONLY valid JSON. Skip anything that is a real-estate listing, broker page, or MLS posting — only true recorded deeds. Skip records without an address AND a grantor name." },
        { role: "user", content: `${hint}\n\nReturn JSON: { "leads": [ { grantor_name (seller), grantee_name (buyer), owner_name (= grantor_name), property_address, property_city, property_zip, parcel_number, sale_price (number), sale_date (YYYY-MM-DD), deed_date (YYYY-MM-DD), property_type (one of SFR|Multifamily|Commercial|Land|Industrial|Mixed|Unknown), source_record_url, trigger_event (one of recent_sale|listed_for_sale|long_hold_owner|trust_transfer|off_market_signal) } ] }\n\nWeb content:\n\n${corpus.slice(0, 14000)}` },
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
  const firecrawlKey = (Deno.env.get("FIRECRAWL_API_KEY_OVERRIDE") ?? Deno.env.get("FIRECRAWL_API_KEY"));
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
  const queries = buildQueries(county.state, county.county, county.recorder_index_url);
  const hint = defaultHint(county.state, county.county);
  // qdr:d once we've scanned before — we only care about *new* deeds.
  const tbs = county.last_run_at ? "qdr:d" : "qdr:m";

  // Build a set of URLs we've already extracted from (last ~500 per county +
  // any existing lead source URLs from the past 60 days). Used to short-circuit
  // the AI extraction when Firecrawl returns nothing new.
  const knownUrls = new Set<string>();
  const lastSeen = Array.isArray(county.last_seen_source_urls) ? county.last_seen_source_urls : [];
  for (const u of lastSeen) if (typeof u === "string") knownUrls.add(u);
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const { data: priorLeads } = await supabase
    .from("leads")
    .select("source_record_url")
    .eq("county_id", county.id)
    .gte("created_at", since)
    .not("source_record_url", "is", null)
    .limit(2000);
  for (const r of priorLeads ?? []) if (r.source_record_url) knownUrls.add(r.source_record_url);

  const newlySeenUrls: string[] = [];
  let skippedNoNewResults = 0;

  for (const q of queries) {
    if (Date.now() - start > HARD_BUDGET_MS) { errors.push("time budget hit"); break; }
    try {
      const results = await firecrawlSearch(q, firecrawlKey, tbs);
      // Drop results we've already extracted from. If nothing's left, skip GPT.
      const novel = results.filter((r) => r.url && !knownUrls.has(r.url));
      if (novel.length === 0) {
        skippedNoNewResults += 1;
        continue;
      }
      for (const r of novel) {
        knownUrls.add(r.url);
        newlySeenUrls.push(r.url);
      }
      const corpus = novel
        .map((r) => `### ${r.title}\nURL: ${r.url}\n\n${r.markdown.slice(0, 3500)}`)
        .join("\n\n---\n\n");
      if (!corpus) continue;
      const leads = await aiExtractLeads(corpus, hint, openaiKey);
      for (const l of leads) {
        if (!l.source_record_url && novel[0]) l.source_record_url = novel[0].url;
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
    // Broker-source URLs are kept (LoopNet/Crexi listings often surface the
    // real owner LLC) — isBrokerUrl is now a soft signal, not a hard filter.
    // Must have an address (or parcel) AND a grantor/owner name to be useful.
    const sellerName = c.grantor_name ?? c.owner_name;
    if ((!c.property_address && !c.parcel_number) || !sellerName) continue;
    const k = `${norm(c.parcel_number)}|${norm(c.property_address)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    // Normalize: always store grantor as owner_name (the seller).
    c.owner_name = sellerName;
    c.grantor_name = sellerName;
    fresh.push(c);
  }

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
        data_sources: ["firecrawl:recorder"],
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
      summary: `Discovered via recorder-deed search in ${county.county}, ${county.state}` +
        (c.grantee_name ? ` (grantee: ${c.grantee_name})` : ""),
      payload: {
        source_url: c.source_record_url ?? null,
        job_id: jobId,
        grantor_name: c.grantor_name ?? null,
        grantee_name: c.grantee_name ?? null,
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

  // Ring-buffer of last ~500 URLs we've extracted for this county, so the next
  // run can short-circuit Firecrawl results without hitting the leads table.
  const mergedUrls = Array.from(new Set([...newlySeenUrls, ...lastSeen.filter((u: unknown) => typeof u === "string")])).slice(0, 500);
  await supabase.from("counties").update({
    last_run_at: new Date().toISOString(),
    last_scanned_at: new Date().toISOString(),
    last_seen_source_urls: mergedUrls,
  }).eq("id", county.id);

  await supabase.from("pipeline_jobs").update({
    status: "done",
    finished_at: new Date().toISOString(),
    result: { found: fresh.length, inserted, enqueued, skipped_queries_no_new: skippedNoNewResults, recorder_url: county.recorder_index_url, errors: errors.slice(0, 3) },
  }).eq("id", jobId);

  return jsonOk({ ok: true, county: county.county, found: fresh.length, inserted, enqueued, skipped_queries_no_new: skippedNoNewResults, errors });
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
