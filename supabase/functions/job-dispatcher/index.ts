// job-dispatcher: cron-driven (every minute). Claims pending jobs from
// pipeline_jobs and fires the matching worker via fire-and-forget.
// Concurrency caps tuned to keep Apollo/Firecrawl spend predictable.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// adapter_id → edge function slug. Kept in sync with _shared/county-adapter.ts
// ADAPTER_DISPATCH (duplicated here to avoid a shared import at dispatch time).
const COUNTY_ADAPTERS: Record<string, string> = {
  travis: "scan-travis-recordings",
};

const KINDS: { kind: string; fn: string; cap: number }[] = [
  { kind: "scan_sources",     fn: "scan-sources",     cap: 2 },
  { kind: "scan_external",    fn: "scan-external-sources", cap: 2 },
  { kind: "scan_county",      fn: "__county_adapter__", cap: 1 },
  // back-compat shim: old payloads with kind=scan_travis_recordings still work
  { kind: "scan_travis_recordings", fn: "scan-travis-recordings", cap: 1 },
  { kind: "verify_property",  fn: "verify-property",  cap: 10 },
  { kind: "qualify_lead",     fn: "qualify-lead",     cap: 20 },
  { kind: "enrich_contact",   fn: "enrich-contact",   cap: 5 },
  { kind: "enrich_assessor",  fn: "enrich-assessor",  cap: 2 },
  { kind: "seller_discovery", fn: "seller-discovery", cap: 3 },
  { kind: "wealth_scan",      fn: "wealth-scan",      cap: 4 },
  { kind: "profile_seller",   fn: "profile-seller",   cap: 6 },
  { kind: "lead_brief",       fn: "lead-brief",       cap: 8 },
  { kind: "draft_outreach_step", fn: "draft-outreach-step", cap: 5 },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const lockId = `dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const summary: Record<string, number> = {};

  for (const { kind, fn, cap } of KINDS) {
    const { data: jobs, error } = await supabase.rpc("claim_jobs", {
      p_kind: kind, p_limit: cap, p_lock_id: lockId,
    });
    if (error) { console.warn(`claim ${kind} failed:`, error.message); continue; }
    const list = (jobs ?? []) as any[];
    summary[kind] = list.length;
    for (const job of list) {
      // scan_county routes by adapter_id from the job payload.
      let target = fn;
      if (kind === "scan_county") {
        const adapterId = (job.payload?.adapter_id ?? "") as string;
        target = COUNTY_ADAPTERS[adapterId];
        if (!target) {
          await supabase.from("pipeline_jobs").update({
            status: "failed", finished_at: new Date().toISOString(),
            last_error: `unknown adapter_id: ${adapterId}`,
          }).eq("id", job.id);
          continue;
        }
      }
      // Fire and forget; do NOT await — workers run independently.
      supabase.functions.invoke(target, { body: { job_id: job.id } }).catch((e) => {
        console.warn(`invoke ${target} for ${job.id} threw:`, e);
      });
    }
  }

  return new Response(JSON.stringify({ ok: true, lock_id: lockId, dispatched: summary }), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
