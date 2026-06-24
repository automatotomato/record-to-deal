// scout-daily: ONE entry point that runs once per day.
//
// Flow per cron tick:
//   1. 20h dedupe guard.
//   2. Queue scan_sources / scan_external / scan_presale for every
//      enabled county / state.
//   3. Run a background drain loop: call job-dispatcher every 20s until
//      two consecutive dispatches yield zero work, or 20 minutes elapse.
//   4. After the loop, fire outreach-cadence-tick once.
//
// No other cron should be active — the every-minute dispatcher cron is
// intentionally paused. This function does the entire day's work.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DRAIN_TICK_MS = 20_000;
const DRAIN_HARD_CEILING_MS = 20 * 60_000; // 20 min
const EMPTY_TICKS_TO_STOP = 2;

// deno-lint-ignore no-explicit-any
const EdgeRuntime: any = (globalThis as any).EdgeRuntime;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: { force?: boolean } = {};
  try { body = await req.json(); } catch (_) { /* empty body ok */ }

  // 20h dedupe guard
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
  const runId = run?.id as string | undefined;

  // ---- Queue scan_sources per county ----
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
      payload: { scout_run_id: runId },
    });
    queuedSources += 1;
  }

  // ---- Queue scan_external per (state, source) ----
  const states = Array.from(new Set((counties ?? []).map((c) => c.state)));
  const externalSources = ["commercial", "pending_sale", "recent_close", "court", "sec"];
  let queuedExternal = 0;
  for (const state of states) {
    for (const source of externalSources) {
      const { count: inflight } = await supabase
        .from("pipeline_jobs")
        .select("id", { count: "exact", head: true })
        .eq("kind", "scan_external")
        .in("status", ["queued", "retry", "running"])
        .contains("payload", { state, source });
      if ((inflight ?? 0) > 0) continue;
      await supabase.from("pipeline_jobs").insert({
        kind: "scan_external", priority: 60,
        payload: { state, source, scout_run_id: runId },
      });
      queuedExternal += 1;
    }
  }

  // ---- Queue scan_presale per state ----
  let queuedPresale = 0;
  for (const state of states) {
    const { count: inflight } = await supabase
      .from("pipeline_jobs")
      .select("id", { count: "exact", head: true })
      .eq("kind", "scan_presale")
      .in("status", ["queued", "retry", "running"])
      .contains("payload", { state });
    if ((inflight ?? 0) > 0) continue;
    await supabase.from("pipeline_jobs").insert({
      kind: "scan_presale", priority: 55,
      payload: { state, scout_run_id: runId },
    });
    queuedPresale += 1;
  }

  await supabase.from("scout_runs")
    .update({ counties_scanned: queuedSources })
    .eq("id", runId);

  // ---- Background drain loop ----
  const drain = async () => {
    const startedAt = Date.now();
    let emptyTicks = 0;
    let totalDispatchCalls = 0;
    while (Date.now() - startedAt < DRAIN_HARD_CEILING_MS) {
      try {
        const { data, error } = await supabase.functions.invoke("job-dispatcher", {
          body: { trigger: "scout-daily-drain", lock: `scout-daily-${runId}-${totalDispatchCalls}` },
        });
        totalDispatchCalls += 1;
        if (error) {
          console.warn("[scout-daily.drain] dispatcher err:", error.message);
        } else {
          const dispatched = data?.dispatched as Record<string, number> | undefined;
          const total = dispatched
            ? Object.values(dispatched).reduce((a, b) => a + (b ?? 0), 0)
            : 0;
          if (total === 0) emptyTicks += 1; else emptyTicks = 0;
          if (emptyTicks >= EMPTY_TICKS_TO_STOP) {
            console.log(`[scout-daily.drain] queue empty after ${totalDispatchCalls} dispatches`);
            break;
          }
        }
      } catch (e) {
        console.warn("[scout-daily.drain] threw:", e);
      }
      await new Promise((r) => setTimeout(r, DRAIN_TICK_MS));
    }

    // Final outreach tick at end of the daily run.
    try {
      await supabase.functions.invoke("outreach-cadence-tick", { body: { trigger: "scout-daily" } });
    } catch (e) {
      console.warn("[scout-daily] outreach tick failed:", e);
    }

    // Mark scout run complete.
    await supabase.from("scout_runs")
      .update({ status: "success" })
      .eq("id", runId);
  };

  if (EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(drain());
  } else {
    // Local/dev fallback — fire and forget.
    drain().catch((e) => console.warn("[scout-daily] drain unhandled:", e));
  }

  return json({
    ok: true,
    scout_run_id: runId,
    queued_sources: queuedSources,
    queued_external: queuedExternal,
    queued_presale: queuedPresale,
    drain: "running_in_background",
  });
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
