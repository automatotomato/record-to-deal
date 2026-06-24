// Shared idempotent enqueue helper.
// Prevents queuing the same kind+lead more than once per day and avoids
// re-doing work the lead already has.

type Supa = ReturnType<typeof import("https://esm.sh/@supabase/supabase-js@2.45.0").createClient>;

export type EnqueueOptions = {
  priority?: number;
  payload?: Record<string, unknown>;
  // Skip if a `done` job of the same kind finished in the last N hours.
  cooldownHours?: number;
  // Skip if the lead already satisfies this predicate (checked against `leads`).
  // Shape: { column: "ai_brief", op: "not_null" } or { column: "decision_maker_email", op: "not_null" }
  unlessLeadHas?: { column: string; op: "not_null" }[];
};

export async function enqueueOnce(
  supabase: Supa,
  kind: string,
  leadId: string,
  opts: EnqueueOptions = {},
): Promise<{ enqueued: boolean; reason?: string }> {
  const cooldownHours = opts.cooldownHours ?? 24;

  // 1) Any in-flight job of same kind for this lead?
  const { count: inflight } = await supabase
    .from("pipeline_jobs")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId)
    .eq("kind", kind)
    .in("status", ["queued", "retry", "running"]);
  if ((inflight ?? 0) > 0) return { enqueued: false, reason: "in_flight" };

  // 2) Done within cooldown window?
  if (cooldownHours > 0) {
    const cutoff = new Date(Date.now() - cooldownHours * 3_600_000).toISOString();
    const { count: recent } = await supabase
      .from("pipeline_jobs")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", leadId)
      .eq("kind", kind)
      .eq("status", "done")
      .gte("finished_at", cutoff);
    if ((recent ?? 0) > 0) return { enqueued: false, reason: "cooldown" };
  }

  // 3) Already-satisfied predicate?
  if (opts.unlessLeadHas?.length) {
    const cols = opts.unlessLeadHas.map((p) => p.column).join(",");
    const { data: lead } = await supabase
      .from("leads")
      .select(cols)
      .eq("id", leadId)
      .maybeSingle();
    if (lead) {
      const satisfied = opts.unlessLeadHas.every((p) =>
        p.op === "not_null" ? (lead as Record<string, unknown>)[p.column] != null : false
      );
      if (satisfied) return { enqueued: false, reason: "already_satisfied" };
    }
  }

  // Insert.
  const { error } = await supabase.from("pipeline_jobs").insert({
    kind, lead_id: leadId,
    priority: opts.priority ?? 70,
    payload: opts.payload ?? null,
  });
  if (error) return { enqueued: false, reason: `insert_failed:${error.message}` };
  return { enqueued: true };
}
