// Pipeline sweeper: nightly safety net that re-runs the right stage on any
// lead that didn't make it all the way to `pipeline_stage='ready'`.
//
// Stages it heals (in order):
//   1. UNSCORED leads          → qualifier-run (will auto-fan to profiler)
//   2. Scored but no contact   → profiler-run (force=true)
//   3. Profiled but no draft   → profiler-run (force=true)  // profiler always writes a draft
//
// Caps each stage at 200 leads/run to keep Apollo + Firecrawl spend predictable.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const STAGE_CAP = 200;
const PROFILER_CONCURRENCY = 5;

async function runProfiler(
  supabase: ReturnType<typeof createClient>,
  ids: string[],
  reason: string,
): Promise<{ ok: number; fail: number }> {
  let ok = 0, fail = 0;
  const queue = [...ids];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      if (!id) break;
      try {
        const { error } = await supabase.functions.invoke("profiler-run", {
          body: { lead_id: id, force: true },
        });
        if (error) throw error;
        ok += 1;
        await supabase.from("lead_activities").insert({
          lead_id: id,
          kind: "sweeper_rerun",
          summary: `Sweeper re-ran profiler · reason: ${reason}`,
        });
      } catch (e) {
        fail += 1;
        console.warn("Sweeper profiler failed for", id, e);
      }
    }
  };
  await Promise.all(
    Array.from({ length: PROFILER_CONCURRENCY }, () => worker()),
  );
  return { ok, fail };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const summary = {
    rescored: 0,
    reprofiled_for_contact: 0,
    redrafted: 0,
    failures: 0,
  };

  // 1) UNSCORED → qualifier (with auto_profile so it cascades)
  const { data: unscored } = await supabase
    .from("leads")
    .select("id")
    .eq("tier", "UNSCORED")
    .limit(STAGE_CAP);
  const unscoredIds = (unscored ?? []).map((r: any) => r.id);
  if (unscoredIds.length) {
    try {
      const { error } = await supabase.functions.invoke("qualifier-run", {
        body: { lead_ids: unscoredIds, auto_profile: true },
      });
      if (error) throw error;
      summary.rescored = unscoredIds.length;
      for (const id of unscoredIds) {
        await supabase.from("lead_activities").insert({
          lead_id: id,
          kind: "sweeper_rerun",
          summary: "Sweeper re-ran qualifier · reason: tier=UNSCORED",
        });
      }
    } catch (e) {
      console.warn("Sweeper qualifier batch failed:", e);
      summary.failures += 1;
    }
  }

  // 2) Scored but missing decision-maker email (skip DISQUALIFIED — they shouldn't be enriched)
  const { data: noContact } = await supabase
    .from("leads")
    .select("id")
    .in("tier", ["URGENT", "HOT", "WARM", "COLD"])
    .in("pipeline_stage", ["scored", "profiled"])
    .is("decision_maker_email", null)
    .limit(STAGE_CAP);
  const noContactIds = (noContact ?? []).map((r: any) => r.id);
  if (noContactIds.length) {
    const r = await runProfiler(supabase, noContactIds, "no decision-maker email");
    summary.reprofiled_for_contact = r.ok;
    summary.failures += r.fail;
  }

  // 3) Profiled/enriched but no draft email row
  const { data: candidates } = await supabase
    .from("leads")
    .select("id")
    .in("pipeline_stage", ["profiled", "enriched"])
    .in("tier", ["URGENT", "HOT", "WARM", "COLD"])
    .limit(STAGE_CAP);
  const candidateIds = (candidates ?? []).map((r: any) => r.id);
  if (candidateIds.length) {
    const { data: withEmails } = await supabase
      .from("outreach_emails")
      .select("lead_id")
      .in("lead_id", candidateIds);
    const have = new Set((withEmails ?? []).map((r: any) => r.lead_id));
    const missing = candidateIds.filter((id) => !have.has(id));
    if (missing.length) {
      const r = await runProfiler(supabase, missing, "no draft email");
      summary.redrafted = r.ok;
      summary.failures += r.fail;
    }
  }

  return new Response(JSON.stringify({ ok: true, ...summary }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
