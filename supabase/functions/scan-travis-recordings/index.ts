// scan-travis-recordings: Travis County (TX) deep-link recorder scraper.
//
// Travis County publishes its Official Public Records search at
// https://www.tccsearch.org/ — a Cloudflare-protected, JS-driven Tyler portal.
// We use Firecrawl /v2/scrape with browser `actions` so it:
//   1) Solves the Cloudflare challenge.
//   2) Navigates to the Official Public Records search.
//   3) Fills the date range (default: last 2 business days).
//   4) Picks deed-type document codes (Warranty / Special Warranty / Trustee's
//      Deed / Grant Deed / Quitclaim Deed).
//   5) Clicks Search and waits for the results grid.
//
// The resulting markdown is fed to gpt-4o-mini with a strict grantor/grantee
// schema, then each row is inserted into `leads` (same shape as scan-sources)
// and verify_property jobs are enqueued.
//
// Job shape:
//   { kind: 'scan_travis_recordings', payload: { from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' } }
//
// Trust gate: every extracted row must have source_record_url on
// tccsearch.org / countyclerk.traviscountytx.gov / traviscountytx.gov.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FIRECRAWL_V2 = "https://api.firecrawl.dev/v2";
const AI_URL = "https://api.openai.com/v1/chat/completions";
const AI_MODEL = "gpt-4o-mini";
const PORTAL_URL = "https://www.tccsearch.org/";
const TRUSTED_HOSTS = [
  "tccsearch.org",
  "countyclerk.traviscountytx.gov",
  "traviscountytx.gov",
];
const DEED_DOC_CODES = [
  "Warranty Deed",
  "Special Warranty Deed",
  "Deed",
  "Trustee's Deed",
  "Quitclaim Deed",
  "Grant Deed",
];

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

function urlIsTrusted(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return TRUSTED_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch (_) { return false; }
}

function fmtMMDDYYYY(d: Date) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}
function fmtYYYYMMDD(d: Date) { return d.toISOString().slice(0, 10); }

function defaultRange(): { from: string; to: string } {
  // last 3 calendar days (covers a weekend), excluding today
  const now = new Date();
  const to = new Date(now.getTime() - 24 * 3600 * 1000);
  const from = new Date(now.getTime() - 4 * 24 * 3600 * 1000);
  return { from: fmtYYYYMMDD(from), to: fmtYYYYMMDD(to) };
}

// Build Firecrawl actions that drive the tccsearch.org portal.
// Selectors target the Tyler Tech "i2 / Public Access" search UI commonly
// used on tccsearch.org. They're conservative (broad attribute matches) so
// minor markup tweaks don't break the run.
function buildActions(fromYmd: string, toYmd: string): unknown[] {
  const [fy, fm, fd] = fromYmd.split("-");
  const [ty, tm, td] = toYmd.split("-");
  const fromUS = `${fm}/${fd}/${fy}`;
  const toUS = `${tm}/${td}/${ty}`;

  return [
    { type: "wait", milliseconds: 6000 }, // Cloudflare challenge
    // Click "Official Public Records" / "Real Property" / "Records" search link.
    { type: "click", selector: "a[href*='OPR'], a[href*='RealProperty'], a:has-text('Official Public Records'), a:has-text('Records Search')" },
    { type: "wait", milliseconds: 4000 },
    // Fill date range (Tyler uses input[name*=From] / input[name*=To]).
    { type: "write", selector: "input[name*='RecordingDateIDStart'], input[id*='RecordingDateIDStart'], input[name*='DateFrom'], input[name*='RecordedDateFrom']", text: fromUS },
    { type: "write", selector: "input[name*='RecordingDateIDEnd'], input[id*='RecordingDateIDEnd'], input[name*='DateTo'], input[name*='RecordedDateTo']", text: toUS },
    // Click Search.
    { type: "click", selector: "input[type='submit'][value*='Search' i], button:has-text('Search'), input[id*='SearchButton']" },
    { type: "wait", milliseconds: 8000 },
    { type: "scrape" },
  ];
}

async function firecrawlScrape(
  url: string,
  apiKey: string,
  actions: unknown[],
): Promise<{ markdown: string; finalUrl: string }> {
  const r = await fetch(`${FIRECRAWL_V2}/scrape`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
      onlyMainContent: false,
      waitFor: 3000,
      timeout: 90_000,
      actions,
      location: { country: "US", languages: ["en"] },
    }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Firecrawl ${r.status}: ${txt.slice(0, 300)}`);
  }
  const data = await r.json();
  const doc = data?.data ?? data;
  const markdown: string = String(doc?.markdown ?? "");
  const finalUrl: string = String(doc?.metadata?.sourceURL ?? doc?.metadata?.url ?? url);
  return { markdown, finalUrl };
}

async function aiExtractLeads(
  corpus: string,
  fallbackUrl: string,
  openaiKey: string,
): Promise<Candidate[]> {
  const hint = `These results are from the Travis County Clerk Official Public Records search (Austin, TX) at tccsearch.org. Extract ONLY rows that are actual recorded real-estate deeds: ${DEED_DOC_CODES.join(", ")}. Use grantor/grantee terminology — the grantee is the NEW owner we want to contact. Skip: Releases, Liens, Affidavits, Mechanic's Liens, Assignments, Powers of Attorney, Marriage Licenses, anything that isn't a property transfer. Skip rows where grantor and grantee are the same. If the page is a login/error/captcha page, return an empty leads array. Always set source_record_url to "${fallbackUrl}" if no per-row URL is present.`;

  const aiResp = await fetch(AI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: "system", content: "You extract recorded-deed transfers from official county recorder web pages. Never invent values. Return ONLY valid JSON." },
        { role: "user", content: `${hint}

Return JSON: { "leads": [ {
  "grantor_name": string,
  "grantee_name": string,
  "document_type": "Warranty Deed" | "Special Warranty Deed" | "Trustee's Deed" | "Quitclaim Deed" | "Grant Deed" | "Deed",
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

Web content:

${corpus.slice(0, 18000)}` },
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : s;
}
function sameParty(a?: string, b?: string) { return !!a && !!b && norm(a) === norm(b); }

function jsonOk(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
async function markFailed(supabase: any, jobId: string, msg: string) {
  await supabase.from("pipeline_jobs").update({
    status: "failed", finished_at: new Date().toISOString(), last_error: msg,
  }).eq("id", jobId);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY_OVERRIDE") ?? Deno.env.get("FIRECRAWL_API_KEY");
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!firecrawlKey || !openaiKey) {
    return new Response(JSON.stringify({ error: "FIRECRAWL_API_KEY or OPENAI_API_KEY missing" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: { job_id?: string; from?: string; to?: string; dry_run?: boolean } = {};
  try { body = await req.json(); } catch (_) {}
  const jobId = body.job_id;
  if (!jobId && !body.dry_run) {
    return new Response(JSON.stringify({ error: "job_id required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let job: any = null;
  let payload: any = {};
  if (jobId) {
    const { data } = await supabase.from("pipeline_jobs").select("*").eq("id", jobId).maybeSingle();
    if (!data) {
      return new Response(JSON.stringify({ error: "job not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    job = data;
    payload = job.payload ?? {};
  }

  // Find Travis County row (may be null on dry_run).
  const { data: county } = await supabase
    .from("counties").select("*")
    .ilike("state", "TX").ilike("county", "Travis")
    .maybeSingle();

  if (!county && jobId) {
    await markFailed(supabase, jobId, "Travis County not found in counties table");
    return jsonOk({ ok: false, error: "travis county row missing" });
  }

  const range = (payload.from && payload.to) || (body.from && body.to)
    ? { from: payload.from ?? body.from!, to: payload.to ?? body.to! }
    : defaultRange();

  const actions = buildActions(range.from, range.to);
  let markdown = "";
  let finalUrl = PORTAL_URL;
  const errors: string[] = [];

  try {
    const res = await firecrawlScrape(PORTAL_URL, firecrawlKey, actions);
    markdown = res.markdown;
    finalUrl = res.finalUrl;
    console.log(`[travis] scrape ok len=${markdown.length} finalUrl=${finalUrl}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[travis] scrape failed: ${msg}`);
    errors.push(msg);
    if (jobId) await markFailed(supabase, jobId, msg);
    return jsonOk({ ok: false, errors });
  }

  if (markdown.length < 500) {
    const msg = `scrape returned too little markdown (len=${markdown.length}) — Cloudflare bypass or selectors probably failed`;
    console.warn(`[travis] ${msg}`);
    errors.push(msg);
    if (jobId) {
      await supabase.from("pipeline_jobs").update({
        status: "failed", finished_at: new Date().toISOString(), last_error: msg,
        result: { markdown_len: markdown.length, final_url: finalUrl },
      }).eq("id", jobId);
    }
    return jsonOk({ ok: false, markdown_len: markdown.length, final_url: finalUrl, errors });
  }

  let candidates: Candidate[] = [];
  try {
    candidates = await aiExtractLeads(markdown, finalUrl, openaiKey);
    console.log(`[travis] AI extracted ${candidates.length} candidates`);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  // Validate + dedupe.
  const seen = new Set<string>();
  const fresh: Candidate[] = [];
  for (const c of candidates) {
    if (!c.grantee_name || !c.document_type) continue;
    if (sameParty(c.grantor_name, c.grantee_name)) continue;
    if (!urlIsTrusted(c.source_record_url ?? finalUrl)) continue;
    if (!c.source_record_url) c.source_record_url = finalUrl;
    const k = `${norm(c.recording_number)}|${norm(c.parcel_number)}|${norm(c.grantee_name)}|${norm(c.property_address)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push(c);
  }

  if (body.dry_run) {
    return jsonOk({ ok: true, dry_run: true, range, found: fresh.length, sample: fresh.slice(0, 3), markdown_preview: markdown.slice(0, 800) });
  }

  let inserted = 0, enqueued = 0;
  for (const c of fresh) {
    const ownerType = inferOwnerType(c.grantee_name);
    const { data: leadRow, error: insErr } = await supabase
      .from("leads")
      .insert({
        county_id: county!.id,
        state: "TX",
        county: "Travis",
        owner_name: c.grantee_name,
        owner_type: ownerType,
        prior_owner_name: c.grantor_name ?? null,
        document_type: c.document_type,
        recording_number: c.recording_number ?? null,
        deed_source_url: c.source_record_url ?? finalUrl,
        property_address: c.property_address ?? null,
        property_city: c.property_city ?? null,
        property_zip: c.property_zip ?? null,
        parcel_number: c.parcel_number ?? null,
        property_type: "Unknown",
        sale_price: c.consideration_amount ?? null,
        sale_date: cleanDate(c.recorded_date),
        deed_date: cleanDate(c.recorded_date),
        trigger_event: "deed_recorded",
        source_record_url: c.source_record_url ?? finalUrl,
        data_sources: ["firecrawl:tccsearch"],
        scout_confidence: 78,
        pipeline_stage: "raw_candidate",
        unmask_status: ownerType !== "Individual" ? "pending" : "unmasked",
      })
      .select("id")
      .single();

    if (insErr) { console.warn("[travis] insert lead failed:", insErr.message); continue; }
    inserted += 1;

    await supabase.from("lead_activities").insert({
      lead_id: leadRow.id,
      kind: "scout_found",
      summary: `Recorded ${c.document_type} in Travis County, TX (grantor: ${c.grantor_name ?? "unknown"} → grantee: ${c.grantee_name})`,
      payload: { source_url: c.source_record_url ?? finalUrl, recording_number: c.recording_number ?? null, job_id: jobId, scraper: "travis-deeplink" },
    });

    await supabase.from("pipeline_jobs").insert({
      kind: "verify_property", lead_id: leadRow.id, priority: 100,
    });
    enqueued += 1;
  }

  if (county) {
    await supabase.from("counties").update({ last_run_at: new Date().toISOString() }).eq("id", county.id);
  }

  await supabase.from("pipeline_jobs").update({
    status: "done",
    finished_at: new Date().toISOString(),
    result: {
      found: fresh.length, inserted, enqueued, range, portal: "Travis County Clerk (tccsearch.org)",
      markdown_len: markdown.length, errors: errors.slice(0, 3),
    },
  }).eq("id", jobId!);

  return jsonOk({ ok: true, range, found: fresh.length, inserted, enqueued, errors });
});
