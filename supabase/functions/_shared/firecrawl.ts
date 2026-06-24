// Shared Firecrawl wrapper. Every caller MUST use this instead of hitting
// api.firecrawl.dev directly. It enforces:
//   1. URL-level cache (skip re-fetches inside the cache window)
//   2. Per-caller daily credit ceiling via fc_reserve_capped()
//   3. Stale in-flight reaping handled inside the DB function
//
// Behavior on cap hit: returns null/[] silently — callers should treat that
// as "no result" and move on. Never throws.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const FC_V2 = "https://api.firecrawl.dev/v2";
const CACHE_DAYS = 14;
const REQ_TIMEOUT_MS = 30_000;

export type FcCaller =
  | "seller-discovery"
  | "enrich-contact"
  | "scan-sources"
  | "scan-external-sources"
  | "scan-presale"
  | "wealth-scan";

let _sb: SupabaseClient | null = null;
function sb(): SupabaseClient {
  if (_sb) return _sb;
  _sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  return _sb;
}

function key(): string | null {
  return Deno.env.get("FIRECRAWL_API_KEY_OVERRIDE")
      ?? Deno.env.get("FIRECRAWL_API_KEY")
      ?? null;
}

async function cachedRecently(url: string): Promise<boolean> {
  if (!url) return false;
  const cutoff = new Date(Date.now() - CACHE_DAYS * 86_400_000).toISOString();
  const { data } = await sb()
    .from("firecrawl_url_cache")
    .select("url")
    .eq("url", url)
    .gte("last_fetched_at", cutoff)
    .maybeSingle();
  return !!data;
}

async function recordCache(url: string, caller: FcCaller, kind: string) {
  if (!url) return;
  await sb().from("firecrawl_url_cache").upsert({
    url, caller, result_kind: kind, last_fetched_at: new Date().toISOString(),
  });
}

async function reserve(caller: FcCaller, credits: number): Promise<string | null> {
  const { data, error } = await sb().rpc("fc_reserve_capped", {
    p_caller: caller, p_credits: credits,
  });
  if (error) { console.warn(`[fc.reserve] ${caller} rpc error:`, error.message); return null; }
  return (data as string | null) ?? null;
}

async function release(id: string | null, actual: number, status: "done" | "failed") {
  if (!id) return;
  await sb().rpc("fc_release", { p_id: id, p_actual: actual, p_status: status });
}

export interface FcSearchResult { url?: string; title?: string; description?: string; markdown?: string }

export async function fcSearch(
  caller: FcCaller,
  query: string,
  opts: { limit?: number; scrape?: boolean; tbs?: string } = {},
): Promise<FcSearchResult[]> {
  const apiKey = key(); if (!apiKey) return [];
  const limit = opts.limit ?? 5;
  // Credit estimate: 1 per search + 1 per scraped result.
  const est = opts.scrape ? 1 + limit : 1;
  const resId = await reserve(caller, est);
  if (!resId) { console.log(`[fc.search] ${caller} throttled`); return []; }

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const body: Record<string, unknown> = { query, limit };
    if (opts.scrape) body.scrapeOptions = { formats: ["markdown"], onlyMainContent: true };
    if (opts.tbs) body.tbs = opts.tbs;

    const r = await fetch(`${FC_V2}/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
    if (!r.ok) {
      const txt = (await r.text()).slice(0, 200);
      console.warn(`[fc.search] ${caller} ${r.status}: ${txt}`);
      await release(resId, 0, "failed");
      return [];
    }
    const d = await r.json();
    const arr = (d?.data?.web ?? d?.data ?? d?.web ?? []) as FcSearchResult[];
    const results = Array.isArray(arr) ? arr : [];

    // Record URLs so subsequent searches that return overlapping results
    // can be deduped by callers (search hits don't strictly need cache
    // but scraped results do).
    if (opts.scrape) {
      for (const r of results) if (r.url) await recordCache(r.url, caller, "search-scrape");
    }
    await release(resId, est, "done");
    return results;
  } catch (e) {
    console.warn(`[fc.search] ${caller} threw:`, e);
    await release(resId, 0, "failed");
    return [];
  } finally { clearTimeout(tid); }
}

export async function fcScrape(
  caller: FcCaller, url: string,
): Promise<string | null> {
  const apiKey = key(); if (!apiKey || !url) return null;

  if (await cachedRecently(url)) {
    console.log(`[fc.scrape] ${caller} cache hit ${url}`);
    return null; // signal cache hit; caller treats as "skip"
  }
  const resId = await reserve(caller, 1);
  if (!resId) { console.log(`[fc.scrape] ${caller} throttled`); return null; }

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const r = await fetch(`${FC_V2}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      await release(resId, 0, "failed");
      return null;
    }
    const d = await r.json();
    const md = d?.data?.markdown ?? d?.markdown ?? null;
    await recordCache(url, caller, "scrape");
    await release(resId, 1, "done");
    return md;
  } catch (e) {
    console.warn(`[fc.scrape] ${caller} threw:`, e);
    await release(resId, 0, "failed");
    return null;
  } finally { clearTimeout(tid); }
}

// Per-lead discovery cooldown: returns true when the worker should SKIP.
// Skips if the lead was attempted in the last `coolHours` AND came back
// partial/failed, or if total attempts have hit the abandon cap.
export interface CooldownDecision {
  skip: boolean;
  reason?: "cooldown" | "abandoned";
  attempts: number;
}
export async function shouldSkipDiscovery(
  leadId: string,
  opts: { coolHours?: number; maxAttempts?: number } = {},
): Promise<CooldownDecision> {
  const coolHours = opts.coolHours ?? 72;
  const maxAttempts = opts.maxAttempts ?? 4;
  const { data } = await sb()
    .from("leads")
    .select("discovery_attempt_count,last_discovery_attempt_at,discovery_status,decision_maker_email,decision_maker_phone")
    .eq("id", leadId)
    .maybeSingle();
  const attempts = data?.discovery_attempt_count ?? 0;
  const status = data?.discovery_status as string | null;
  const hasContact = !!(data?.decision_maker_email || data?.decision_maker_phone);

  if (hasContact) return { skip: false, attempts };
  if (attempts >= maxAttempts) return { skip: true, reason: "abandoned", attempts };

  if (data?.last_discovery_attempt_at && (status === "partial" || status === "failed")) {
    const last = new Date(data.last_discovery_attempt_at).getTime();
    if (Date.now() - last < coolHours * 3_600_000) {
      return { skip: true, reason: "cooldown", attempts };
    }
  }
  return { skip: false, attempts };
}

export async function recordDiscoveryAttempt(leadId: string) {
  const { data } = await sb().from("leads")
    .select("discovery_attempt_count").eq("id", leadId).maybeSingle();
  const next = (data?.discovery_attempt_count ?? 0) + 1;
  await sb().from("leads").update({
    discovery_attempt_count: next,
    last_discovery_attempt_at: new Date().toISOString(),
  }).eq("id", leadId);
}

// When a lead has exhausted attempts, park it in needs_review and stop.
export async function parkAbandoned(leadId: string) {
  await sb().from("leads").update({
    pipeline_stage: "needs_review",
    discovery_status: "failed",
    updated_at: new Date().toISOString(),
  }).eq("id", leadId);
  await sb().from("lead_activities").insert({
    lead_id: leadId,
    kind: "enriched",
    summary: "Parked in Needs Review after 4 unsuccessful discovery attempts — pipeline focus shifts to new opportunities.",
    payload: { reason: "discovery_attempts_exhausted" },
  });
}
