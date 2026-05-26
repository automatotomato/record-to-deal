// outreach-cadence-tick: runs every 15 min via cron.
// 1) Assigns an outreach_sequence to ready leads that don't have one yet
//    (whale/affluent + high-tax LLC → high_tax_llc_whale, individuals → high_tax_individual,
//     federal-only states (FL/TX) → federal_only_commercial).
// 2) Enqueues draft_outreach_step jobs for any lead whose outreach_next_step_at <= now()
//    and that has the contact info needed for the next step.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FEDERAL_ONLY_STATES = new Set(["FL", "TX", "WA", "TN", "NV", "SD", "WY", "AK", "NH"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const summary = { assigned: 0, presale_assigned: 0, enqueued: 0, skipped: 0 };

  // Load sequences once
  const { data: seqs } = await supabase.from("outreach_sequences").select("id, key").eq("is_active", true);
  const seqByKey: Record<string, string> = {};
  for (const s of seqs ?? []) seqByKey[s.key] = s.id;

  // 1a) Assign PRE-SALE ADVISOR to pre_sale_prospect leads (listings, no sale yet).
  // These are the highest-leverage outreach — engage BEFORE the 45-day clock starts.
  const presaleSeqId = seqByKey["pre_sale_advisor"];
  if (presaleSeqId) {
    const { data: presale } = await supabase
      .from("leads")
      .select("id")
      .is("outreach_sequence_id", null)
      .eq("pipeline_stage", "pre_sale_prospect")
      .not("tier", "in", "(DISQUALIFIED,EXPIRED)")
      .limit(100);
    for (const l of presale ?? []) {
      await supabase.from("leads").update({
        outreach_sequence_id: presaleSeqId,
        outreach_step_index: 0,
        outreach_next_step_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", l.id);
      await supabase.from("lead_activities").insert({
        lead_id: l.id, kind: "sequence_assigned",
        summary: "Assigned sequence: pre_sale_advisor",
        payload: { sequence_key: "pre_sale_advisor" },
      });
      summary.presale_assigned += 1;
    }
  }

  // 1b) Assign sequences to ready leads without one
  const { data: needsAssign } = await supabase
    .from("leads")
    .select("id, owner_type, state, wealth_tier, has_outreach_contact, readiness, tier")
    .is("outreach_sequence_id", null)
    .eq("readiness", "ready_for_outreach")
    .not("tier", "in", "(DISQUALIFIED,EXPIRED)")
    .limit(100);

  for (const l of needsAssign ?? []) {
    let key: string | null = null;
    const isEntity = !["individual", "Individual", "unknown", "Unknown", null, ""].includes(l.owner_type);
    const isWhale = l.wealth_tier === "whale" || l.wealth_tier === "affluent";
    const stateUp = (l.state || "").toUpperCase();

    if (FEDERAL_ONLY_STATES.has(stateUp)) {
      key = "federal_only_commercial";
    } else if (isEntity && isWhale) {
      key = "high_tax_llc_whale";
    } else if (isEntity) {
      key = "high_tax_llc_whale"; // entities default to LLC track
    } else {
      key = "high_tax_individual";
    }
    const seqId = key ? seqByKey[key] : null;
    if (!seqId) continue;

    await supabase.from("leads").update({
      outreach_sequence_id: seqId,
      outreach_step_index: 0,
      outreach_next_step_at: new Date().toISOString(), // start now
      updated_at: new Date().toISOString(),
    }).eq("id", l.id);
    await supabase.from("lead_activities").insert({
      lead_id: l.id, kind: "sequence_assigned",
      summary: `Assigned sequence: ${key}`,
      payload: { sequence_key: key },
    });
    summary.assigned += 1;
  }


  // 2) Enqueue due steps
  const { data: due } = await supabase
    .from("leads")
    .select("id")
    .not("outreach_sequence_id", "is", null)
    .not("outreach_next_step_at", "is", null)
    .lte("outreach_next_step_at", new Date().toISOString())
    .not("tier", "in", "(DISQUALIFIED,EXPIRED)")
    .limit(200);

  for (const l of due ?? []) {
    const { count } = await supabase
      .from("pipeline_jobs")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", l.id)
      .eq("kind", "draft_outreach_step")
      .in("status", ["queued", "retry", "running"]);
    if ((count ?? 0) > 0) { summary.skipped += 1; continue; }

    await supabase.from("pipeline_jobs").insert({
      kind: "draft_outreach_step", lead_id: l.id, priority: 70,
    });
    summary.enqueued += 1;
  }

  return new Response(JSON.stringify({ ok: true, ...summary }), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
