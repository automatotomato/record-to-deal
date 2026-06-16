// Shared county-adapter framework. Each county scraper (Travis, ACRIS, Cook, …)
// implements `CountyAdapter` and `runAdapter` handles dedupe / lead insert /
// verify_property enqueue / scout_runs accounting.
//
// To add a new county:
//   1. Create supabase/functions/scan-<id>-recordings/index.ts
//   2. Add `<id>` to ADAPTER_DISPATCH map below
//   3. Add `adapter: '<id>'` on the county row in _shared/recorder-sources.ts

export type Candidate = {
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

/** adapter_id → edge function slug. Single source of truth used by job-dispatcher. */
export const ADAPTER_DISPATCH: Record<string, string> = {
  travis: "scan-travis-recordings",
};

export const FORBIDDEN_HOSTS = [
  "loopnet", "crexi", "costar", "zillow", "trulia", "realtor.com",
  "redfin", "homes.com", "movoto", "auction.com",
];

export function hostIsTrusted(url: string | null | undefined, trustedHosts: string[]): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (FORBIDDEN_HOSTS.some((d) => host.includes(d))) return false;
    return trustedHosts.some((d) => host === d || host.endsWith(`.${d}`));
  } catch { return false; }
}

export function inferOwnerType(name?: string | null): "LLC" | "Trust" | "Corporation" | "Estate" | "Individual" | "Unknown" {
  if (!name) return "Unknown";
  const n = name.toLowerCase();
  if (/\bllc\b|\bl\.l\.c\b/.test(n)) return "LLC";
  if (/\btrust\b|\btrustee\b/.test(n)) return "Trust";
  if (/\bcorp\b|\binc\b|\bcompany\b|\bco\.\b/.test(n)) return "Corporation";
  if (/\bestate of\b/.test(n)) return "Estate";
  return "Individual";
}

export const norm = (s: string | null | undefined) =>
  (s ?? "").toString().trim().toUpperCase().replace(/\s+/g, " ").replace(/[.,]/g, "");

export function sameParty(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && norm(a) === norm(b);
}

export function cleanDate(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : s;
}

export interface RunSummary {
  raw_url_count: number;
  trusted_url_count: number;
  extracted_count: number;
  inserted_count: number;
  enqueued_count: number;
  rejected: Record<string, number>;
  errors: string[];
  range?: { from: string; to: string };
  portal?: string;
}

export interface AdapterCtx {
  supabase: any;
  firecrawlKey: string;
  openaiKey: string;
  range: { from: string; to: string };
  jobId?: string;
  dryRun?: boolean;
}

export interface CountyAdapter {
  id: string;            // 'travis'
  state: string;         // 'TX'
  county: string;        // 'Travis'
  portalName: string;
  trustedHosts: string[];
  /** Adapter implementation: scrape + AI extract → Candidate[] */
  scrape(ctx: AdapterCtx): Promise<{ candidates: Candidate[]; finalUrl: string; markdownLen: number; rawUrlCount: number }>;
}

/** Default last-3-day range (excludes today, covers weekends). */
export function defaultRange(): { from: string; to: string } {
  const to = new Date(Date.now() - 24 * 3600 * 1000);
  const from = new Date(Date.now() - 4 * 24 * 3600 * 1000);
  const f = (d: Date) => d.toISOString().slice(0, 10);
  return { from: f(from), to: f(to) };
}

/**
 * Persists candidates as leads + enqueues verify_property + writes summary.
 * Returns the RunSummary (caller writes it to scout_runs / pipeline_jobs.result).
 */
export async function persistCandidates(
  adapter: CountyAdapter,
  candidates: Candidate[],
  finalUrl: string,
  ctx: AdapterCtx,
  rawUrlCount: number,
): Promise<RunSummary> {
  const rejected: Record<string, number> = {};
  const bump = (k: string) => { rejected[k] = (rejected[k] ?? 0) + 1; };

  // Look up county row (best-effort).
  const { data: county } = await ctx.supabase
    .from("counties").select("id")
    .ilike("state", adapter.state).ilike("county", adapter.county)
    .maybeSingle();

  const seen = new Set<string>();
  const fresh: Candidate[] = [];
  let trustedCount = 0;
  for (const c of candidates) {
    if (!c.grantee_name || !c.document_type) { bump("missing_party_or_doc"); continue; }
    if (sameParty(c.grantor_name, c.grantee_name)) { bump("self_transfer"); continue; }
    const url = c.source_record_url ?? finalUrl;
    if (!hostIsTrusted(url, adapter.trustedHosts)) { bump("untrusted_url"); continue; }
    trustedCount += 1;
    if (!c.source_record_url) c.source_record_url = finalUrl;
    const k = `${norm(c.recording_number)}|${norm(c.parcel_number)}|${norm(c.grantee_name)}|${norm(c.property_address)}`;
    if (seen.has(k)) { bump("duplicate"); continue; }
    seen.add(k);
    fresh.push(c);
  }

  const summary: RunSummary = {
    raw_url_count: rawUrlCount,
    trusted_url_count: trustedCount,
    extracted_count: candidates.length,
    inserted_count: 0,
    enqueued_count: 0,
    rejected,
    errors: [],
    portal: adapter.portalName,
    range: ctx.range,
  };

  if (ctx.dryRun) return summary;

  for (const c of fresh) {
    const ownerType = inferOwnerType(c.grantee_name);
    const { data: leadRow, error: insErr } = await ctx.supabase
      .from("leads")
      .insert({
        county_id: county?.id ?? null,
        state: adapter.state,
        county: adapter.county,
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
        data_sources: [`firecrawl:${adapter.id}`],
        scout_confidence: 78,
        pipeline_stage: "raw_candidate",
        assessor_status: "pending",
        unmask_status: ownerType !== "Individual" ? "pending" : "unmasked",
      })
      .select("id")
      .single();

    if (insErr) {
      summary.errors.push(`insert: ${insErr.message}`);
      bump("insert_failed");
      continue;
    }
    summary.inserted_count += 1;

    await ctx.supabase.from("lead_activities").insert({
      lead_id: leadRow.id,
      kind: "scout_found",
      summary: `Recorded ${c.document_type} in ${adapter.county}, ${adapter.state} (${c.grantor_name ?? "?"} → ${c.grantee_name})`,
      payload: {
        source_url: c.source_record_url ?? finalUrl,
        recording_number: c.recording_number ?? null,
        job_id: ctx.jobId ?? null,
        adapter: adapter.id,
      },
    });

    await ctx.supabase.from("pipeline_jobs").insert({
      kind: "verify_property", lead_id: leadRow.id, priority: 100,
    });
    summary.enqueued_count += 1;
  }

  if (county?.id) {
    await ctx.supabase.from("counties").update({ last_run_at: new Date().toISOString() }).eq("id", county.id);
  }

  return summary;
}
