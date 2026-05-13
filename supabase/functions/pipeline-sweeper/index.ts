// pipeline-sweeper: nightly safety net for the queued pipeline.
// 1) Reset jobs stuck in 'running' for >10 min back to 'queued'.
// 2) Re-enqueue leads whose stage is behind their data (heals stragglers).
// 3) Move sales > 180 days old to EXPIRED.
// 4) Clean up done jobs older than 7 days.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const STAGE_CAP = 200;
const STUCK_MINUTES = 10;
const RETENTION_DAYS = 7;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const summary = { stuck_reset: 0, requalified: 0, re_enriched: 0, re_drafted: 0, expired: 0, cleaned: 0 };

  // 1) Reset stuck running jobs (worker died mid-run)
  const stuckCutoff = new Date(Date.now() - STUCK_MINUTES * 60 * 1000).toISOString();
  const { data: stuck } = await supabase
    .from("pipeline_jobs")
    .update({ status: "queued", locked_at: null, locked_by: null, last_error: "reset by sweeper (stuck)" })
    .eq("status", "running")
    .lt("locked_at", stuckCutoff)
    .select("id");
  summary.stuck_reset = stuck?.length ?? 0;

  // 2) Heal stragglers — verified but not qualified
  const { data: needQualify } = await supabase
    .from("leads")
    .select("id")
    .eq("pipeline_stage", "verified")
    .limit(STAGE_CAP);
  for (const r of needQualify ?? []) {
    await supabase.from("pipeline_jobs").insert({ kind: "qualify_lead", lead_id: r.id, priority: 90 });
    summary.requalified += 1;
  }

  // 2b) Qualified but no enrichment job in flight
  const { data: needEnrich } = await supabase
    .from("leads")
    .select("id")
    .eq("pipeline_stage", "qualified")
    .limit(STAGE_CAP);
  for (const r of needEnrich ?? []) {
    const { count } = await supabase.from("pipeline_jobs")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", r.id)
      .eq("kind", "enrich_contact")
      .in("status", ["queued", "retry", "running"]);
    if ((count ?? 0) === 0) {
      await supabase.from("pipeline_jobs").insert({ kind: "enrich_contact", lead_id: r.id, priority: 80 });
      summary.re_enriched += 1;
    }
  }

  // 2c) Enriched but no draft job in flight
  const { data: needDraft } = await supabase
    .from("leads")
    .select("id")
    .eq("pipeline_stage", "enriched")
    .eq("has_outreach_contact", true)
    .limit(STAGE_CAP);
  for (const r of needDraft ?? []) {
    const { count } = await supabase.from("pipeline_jobs")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", r.id)
      .eq("kind", "draft_outreach")
      .in("status", ["queued", "retry", "running"]);
    if ((count ?? 0) === 0) {
      await supabase.from("pipeline_jobs").insert({ kind: "draft_outreach", lead_id: r.id, priority: 70 });
      summary.re_drafted += 1;
    }
  }

  // 3) Expire 180+ day sales
  const expiredCutoff = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
  const { data: expiredRows } = await supabase
    .from("leads")
    .update({ tier: "EXPIRED", pipeline_stage: "expired", is_urgent: false })
    .lt("sale_date", expiredCutoff)
    .not("tier", "in", "(EXPIRED,DISQUALIFIED)")
    .select("id");
  summary.expired = expiredRows?.length ?? 0;

  // 4) Clean old done jobs
  const cleanCutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  const { data: cleaned } = await supabase
    .from("pipeline_jobs")
    .delete()
    .eq("status", "done")
    .lt("finished_at", cleanCutoff)
    .select("id");
  summary.cleaned = cleaned?.length ?? 0;

  return new Response(JSON.stringify({ ok: true, ...summary }), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
