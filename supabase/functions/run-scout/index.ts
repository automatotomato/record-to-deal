// run-scout: single orchestrator entry point invoked by UI (user JWT) and
// pg_cron (service-role JWT). Enqueues a coordinated wave of scout jobs:
//   - scan_sources (generic Firecrawl recorder search) per enabled county
//     that does NOT have a dedicated adapter
//   - scan_county (deep-link county adapters, e.g. Travis) per enabled county
//     that DOES have an adapter
//   - scan_external (pre-sale / brokerage / news discovery)
//
// Auth model:
//   - Staff user JWT  → allowed
//   - Service-role JWT (used by cron) → allowed
//   - Everything else → 403
//
// Rate limit: refuses if a scout_runs row was created in the last 10 minutes
// with the same { kinds, states } scope, unless { force: true } + staff.
//
// Input (zod-validated):
//   { kinds?: ('scan_sources'|'scan_external'|'scan_county')[],
//     states?: string[],   // 2-letter, filtered against registry
//     dry_run?: boolean,
//     force?: boolean }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";
import { ADAPTER_DISPATCH } from "../_shared/county-adapter.ts";
import { PRIORITY_STATES, RECORDER_REGISTRY } from "../_shared/recorder-sources.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const InputSchema = z.object({
  kinds: z.array(z.enum(["scan_sources", "scan_external", "scan_county"])).optional(),
  states: z.array(z.string().length(2)).optional(),
  dry_run: z.boolean().optional(),
  force: z.boolean().optional(),
});

const DEFAULT_KINDS = ["scan_sources", "scan_county", "scan_external"] as const;
const RATE_LIMIT_MIN = 10;

function jsonOk(b: unknown) {
  return new Response(JSON.stringify(b), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function jsonErr(msg: string, status: number, extra?: Record<string, unknown>) {
  return new Response(JSON.stringify({ error: msg, ...(extra ?? {}) }), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonErr("POST required", 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // ---- Auth gate
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const cronSecret = Deno.env.get("RUN_SCOUT_CRON_SECRET");
  const presentedCron = req.headers.get("x-cron-secret") ?? "";

  let triggeredBy: string | null = null;
  let isCron = (token && token === serviceKey) || (!!cronSecret && presentedCron === cronSecret);
  if (!isCron) {
    if (!token) return jsonErr("unauthorized", 401);
    // Validate user JWT + staff role
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: claims, error } = await userClient.auth.getClaims(token);
    if (error || !claims?.claims?.sub) return jsonErr("unauthorized", 401);
    triggeredBy = claims.claims.sub as string;
    const { data: staff } = await admin.rpc("is_staff", { _user_id: triggeredBy });
    if (!staff) return jsonErr("forbidden — staff only", 403);
  }

  // ---- Input
  let raw: unknown = {};
  try { raw = await req.json(); } catch (_) {}
  const parsed = InputSchema.safeParse(raw);
  if (!parsed.success) return jsonErr("invalid input", 400, { issues: parsed.error.flatten() });
  const input = parsed.data;

  const kinds = input.kinds && input.kinds.length ? input.kinds : [...DEFAULT_KINDS];
  const wantedStates = (input.states ?? PRIORITY_STATES.slice())
    .map((s) => s.toUpperCase())
    .filter((s) => (PRIORITY_STATES as readonly string[]).includes(s));

  // ---- Rate limit
  if (!input.force) {
    const since = new Date(Date.now() - RATE_LIMIT_MIN * 60 * 1000).toISOString();
    const { data: recent } = await admin
      .from("scout_runs")
      .select("id, started_at, errors")
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(5);
    const scope = JSON.stringify({ kinds: kinds.sort(), states: wantedStates.sort() });
    const dup = (recent ?? []).find((r: any) => {
      const e = Array.isArray(r.errors) ? r.errors : [];
      return e.some?.((x: any) => x?.scope === scope);
    });
    if (dup) {
      return jsonErr(`rate limited — same scope ran within ${RATE_LIMIT_MIN}m`, 429, {
        last_run_id: dup.id, last_run_at: dup.started_at,
      });
    }
  }

  // ---- Build job plan
  const { data: counties } = await admin
    .from("counties")
    .select("id, state, county, enabled, parser_key")
    .eq("enabled", true);

  const { data: rates } = await admin
    .from("state_tax_rates")
    .select("state, priority_rank");
  const rankByState = new Map<string, number>();
  for (const r of rates ?? []) rankByState.set(r.state, r.priority_rank ?? 99);

  const jobsToInsert: any[] = [];
  const plan: Record<string, number> = {};

  for (const c of counties ?? []) {
    if (!wantedStates.includes(c.state)) continue;
    const stateEntry = RECORDER_REGISTRY[c.state as keyof typeof RECORDER_REGISTRY];
    if (!stateEntry) continue;
    const countyKey = Object.keys(stateEntry.counties).find(
      (k) => k.toLowerCase().replace(/\s+county$/i, "").trim() ===
             c.county.toLowerCase().replace(/\s+county$/i, "").trim(),
    );
    const countyEntry = countyKey ? (stateEntry.counties as any)[countyKey] : null;
    const adapterId = countyEntry?.adapter as string | undefined;
    const priority = (rankByState.get(c.state) ?? 99) * 10;

    if (adapterId && ADAPTER_DISPATCH[adapterId] && kinds.includes("scan_county")) {
      jobsToInsert.push({
        kind: "scan_county",
        county_id: c.id,
        priority,
        payload: { adapter_id: adapterId },
      });
      plan.scan_county = (plan.scan_county ?? 0) + 1;
    } else if (!adapterId && kinds.includes("scan_sources")) {
      jobsToInsert.push({
        kind: "scan_sources",
        county_id: c.id,
        priority,
      });
      plan.scan_sources = (plan.scan_sources ?? 0) + 1;
    }
  }

  if (kinds.includes("scan_external")) {
    jobsToInsert.push({ kind: "scan_external", priority: 50, payload: { states: wantedStates } });
    plan.scan_external = 1;
  }

  // Dedupe against in-flight jobs (same kind + county_id, queued/retry/running).
  if (jobsToInsert.length) {
    const { data: active } = await admin
      .from("pipeline_jobs")
      .select("kind, county_id")
      .in("kind", Array.from(new Set(jobsToInsert.map((j) => j.kind))))
      .in("status", ["queued", "retry", "running"]);
    const activeKey = new Set((active ?? []).map((j: any) => `${j.kind}|${j.county_id ?? ""}`));
    for (let i = jobsToInsert.length - 1; i >= 0; i--) {
      const k = `${jobsToInsert[i].kind}|${jobsToInsert[i].county_id ?? ""}`;
      if (activeKey.has(k)) jobsToInsert.splice(i, 1);
    }
  }

  if (input.dry_run) {
    return jsonOk({
      ok: true, dry_run: true, kinds, states: wantedStates,
      planned: jobsToInsert.length, plan, jobs: jobsToInsert.slice(0, 20),
    });
  }

  // ---- Insert scout_runs row + jobs
  const { data: runRow, error: runErr } = await admin
    .from("scout_runs")
    .insert({
      triggered_by: triggeredBy,
      trigger_kind: isCron ? "cron" : "manual",
      status: "running",
      counties_scanned: 0,
    })
    .select("id")
    .single();
  if (runErr) return jsonErr(`scout_runs insert: ${runErr.message}`, 500);

  let inserted: any[] = [];
  if (jobsToInsert.length) {
    const { data: ins, error: jErr } = await admin
      .from("pipeline_jobs")
      .insert(jobsToInsert.map((j) => ({ ...j, payload: { ...(j.payload ?? {}), scout_run_id: runRow.id } })))
      .select("id, kind");
    if (jErr) {
      await admin.from("scout_runs").update({
        status: "failed",
        finished_at: new Date().toISOString(),
        errors: [{ error: jErr.message }],
      }).eq("id", runRow.id);
      return jsonErr(`job insert: ${jErr.message}`, 500);
    }
    inserted = ins ?? [];
  }

  // Stamp scope into errors jsonb (re-using the column for run metadata since
  // we don't want a schema change just for rate-limit lookup).
  await admin.from("scout_runs").update({
    errors: [{
      scope: JSON.stringify({ kinds: kinds.sort(), states: wantedStates.sort() }),
      planned_job_ids: inserted.map((j) => j.id),
      plan,
    }],
    counties_scanned: plan.scan_county ?? 0 + (plan.scan_sources ?? 0),
  }).eq("id", runRow.id);

  // Kick the dispatcher so jobs start now (don't wait for cron).
  admin.functions.invoke("job-dispatcher", { body: { trigger: "run-scout" } }).catch(() => {});

  return jsonOk({
    ok: true,
    scout_run_id: runRow.id,
    triggered_by: isCron ? "cron" : "ui",
    kinds, states: wantedStates,
    inserted: inserted.length, plan,
  });
});
