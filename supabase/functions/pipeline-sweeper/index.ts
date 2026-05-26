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

  const summary = {
    stuck_reset: 0, requalified: 0, re_enriched: 0, re_discovered: 0,
    re_briefed: 0, re_drafted: 0, expired: 0, cleaned: 0,
  };
  const BRIEF_STALE_MIN = 30;

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
      .eq("kind", "draft_outreach_step")
      .in("status", ["queued", "retry", "running"]);
    if ((count ?? 0) === 0) {
      await supabase.from("pipeline_jobs").insert({ kind: "draft_outreach_step", lead_id: r.id, priority: 70 });
      summary.re_drafted += 1;
    }
  }

  // 2d) Leads in seller-discovery limbo (needs_review, no recent discovery job)
  const { data: needDiscovery } = await supabase
    .from("leads")
    .select("id")
    .eq("pipeline_stage", "needs_review")
    .in("tier", ["URGENT", "CRITICAL", "ACTIVE", "HOT", "WARM"])
    .limit(STAGE_CAP);
  for (const r of needDiscovery ?? []) {
    const { count } = await supabase.from("pipeline_jobs")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", r.id)
      .eq("kind", "seller_discovery")
      .in("status", ["queued", "retry", "running"]);
    if ((count ?? 0) === 0) {
      await supabase.from("pipeline_jobs").insert({ kind: "seller_discovery", lead_id: r.id, priority: 60 });
      summary.re_discovered += 1;
    }
  }

  // 2e) Qualified leads missing AI brief — re-enqueue regardless of contact info
  const briefStaleCutoff = new Date(Date.now() - BRIEF_STALE_MIN * 60_000).toISOString();
  const { data: needBrief } = await supabase
    .from("leads")
    .select("id")
    .is("ai_brief", null)
    .in("tier", ["URGENT", "CRITICAL", "ACTIVE", "HOT", "WARM"])
    .not("pipeline_stage", "in", "(discovered,scoring,disqualified,expired)")
    .lt("updated_at", briefStaleCutoff)
    .limit(STAGE_CAP);
  for (const r of needBrief ?? []) {
    const { count } = await supabase.from("pipeline_jobs")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", r.id)
      .eq("kind", "lead_brief")
      .in("status", ["queued", "retry", "running"]);
    if ((count ?? 0) === 0) {
      await supabase.from("pipeline_jobs").insert({ kind: "lead_brief", lead_id: r.id, priority: 75 });
      summary.re_briefed += 1;
    }
  }

  // 3) Purge leads outside the 90-day actionable window (and any already disqualified/expired).
  //    Pre-sale prospects have no sale_date and are preserved.
  const purgeCutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const { data: toPurge } = await supabase
    .from("leads")
    .select("id")
    .or(`sale_date.lt.${purgeCutoff},pipeline_stage.eq.disqualified,pipeline_stage.eq.expired,tier.eq.EXPIRED,tier.eq.DISQUALIFIED`);
  const purgeIds = (toPurge ?? []).map((r: any) => r.id);
  if (purgeIds.length) {
    await supabase.from("lead_activities").delete().in("lead_id", purgeIds);
    await supabase.from("lead_touchpoints").delete().in("lead_id", purgeIds);
    await supabase.from("outreach_touches").delete().in("lead_id", purgeIds);
    await supabase.from("outreach_emails").delete().in("lead_id", purgeIds);
    await supabase.from("pipeline_jobs").delete().in("lead_id", purgeIds);
    await supabase.from("leads").delete().in("id", purgeIds);
  }
  summary.expired = purgeIds.length;


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
