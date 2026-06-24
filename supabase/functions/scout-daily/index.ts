// scout-daily: single guarded daily entry point. Replaces the two old
// crons (`run-scan-daily-7am` + `daily-scan-8am`). Skips if a run already
// completed today (UTC). Inserts scan jobs and fires the dispatcher once.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: { force?: boolean } = {};
  try { body = await req.json(); } catch (_) {}

  // 24h guard: skip if a daily run already kicked off in the last 20h.
  if (!body.force) {
    const since = new Date(Date.now() - 20 * 3_600_000).toISOString();
    const { count } = await supabase
      .from("scout_runs")
      .select("id", { count: "exact", head: true })
      .eq("trigger_kind", "cron")
      .gte("started_at", since);
    if ((count ?? 0) > 0) {
      return json({ ok: true, skipped: "already_ran_today" });
    }
  }

  const { data: run } = await supabase
    .from("scout_runs")
    .insert({ trigger_kind: "cron", status: "running", counties_scanned: 0 })
    .select("id")
    .single();

  // Queue scan_sources for each enabled county that doesn't already have one in flight.
  const { data: counties } = await supabase
    .from("counties")
    .select("id, state")
    .eq("enabled", true);

  let queuedSources = 0;
  for (const c of counties ?? []) {
    const { count: inflight } = await supabase
      .from("pipeline_jobs")
      .select("id", { count: "exact", head: true })
      .eq("kind", "scan_sources")
      .eq("county_id", c.id)
      .in("status", ["queued", "retry", "running"]);
    if ((inflight ?? 0) > 0) continue;
    await supabase.from("pipeline_jobs").insert({
      kind: "scan_sources", county_id: c.id, priority: 50,
      payload: { scout_run_id: run?.id },
    });
    queuedSources += 1;
  }

  // Queue scan_external once per (state, source).
  const states = Array.from(new Set((counties ?? []).map((c) => c.state)));
  const sources = ["commercial", "pending_sale", "recent_close", "court", "sec"];
  let queuedExternal = 0;
  for (const state of states) {
    for (const source of sources) {
      const { count: inflight } = await supabase
        .from("pipeline_jobs")
        .select("id", { count: "exact", head: true })
        .eq("kind", "scan_external")
        .in("status", ["queued", "retry", "running"])
        .contains("payload", { state, source });
      if ((inflight ?? 0) > 0) continue;
      await supabase.from("pipeline_jobs").insert({
        kind: "scan_external", priority: 60,
        payload: { state, source, scout_run_id: run?.id },
      });
      queuedExternal += 1;
    }
  }

  await supabase.from("scout_runs")
    .update({ counties_scanned: queuedSources })
    .eq("id", run?.id);

  // Fire dispatcher once (workers will be drained by the 5-min tick afterward too).
  supabase.functions.invoke("job-dispatcher", { body: { trigger: "scout-daily" } })
    .catch((e) => console.warn("dispatcher invoke failed:", e));

  return json({ ok: true, scout_run_id: run?.id, queued_sources: queuedSources, queued_external: queuedExternal });
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
