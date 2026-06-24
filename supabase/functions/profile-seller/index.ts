// profile-seller: classifies seller personality, motivation, preferred channel,
// pitch angle, and Las Vegas replacement-property recommendation. Runs after
// seller-discovery for leads with score >= 50. Pure inference over existing facts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { enqueueOnce } from "../_shared/enqueue.ts";

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
  const aiKey = Deno.env.get("OPENAI_API_KEY");
  const aiModel = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";

  try {
    const body = await req.json().catch(() => ({}));
    let leadId = body?.lead_id;
    const jobId = body?.job_id;
    if (!leadId && jobId) {
      const { data: job } = await supabase.from("pipeline_jobs").select("lead_id").eq("id", jobId).maybeSingle();
      leadId = job?.lead_id ?? null;
    }
    if (!leadId) return jsonErr("lead_id required", 400);
    if (!aiKey) return finishJob(supabase, jobId, "OPENAI_API_KEY missing", true);

    const { data: lead, error } = await supabase.from("leads").select("*").eq("id", leadId).maybeSingle();
    if (error || !lead) return finishJob(supabase, jobId, "lead not found", true);

    // Early-exit: skip (not fail) when inputs are insufficient. Stops the
    // attempts loop from burning tokens on leads that can't be profiled yet.
    if (!lead.decision_maker_name || !lead.owner_name) {
      if (jobId) {
        await supabase.from("pipeline_jobs").update({
          status: "done", finished_at: new Date().toISOString(),
          result: { skipped: "missing_decision_maker_or_owner" },
        }).eq("id", jobId);
      }
      return new Response(JSON.stringify({ ok: true, skipped: "missing_inputs" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (lead.profiler_summary) {
      if (jobId) {
        await supabase.from("pipeline_jobs").update({
          status: "done", finished_at: new Date().toISOString(),
          result: { skipped: "already_profiled" },
        }).eq("id", jobId);
      }
      return new Response(JSON.stringify({ ok: true, skipped: "already_profiled" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const facts = {
      owner_name: lead.owner_name,
      owner_type: lead.owner_type,
      decision_maker_name: lead.decision_maker_name,
      decision_maker_role: lead.decision_maker_role,
      company_website: lead.company_website,
      property_type: lead.property_type,
      property_address: lead.property_address,
      property_city: lead.property_city,
      state: lead.state,
      sale_price: lead.sale_price,
      ownership_years: lead.ownership_years,
      assessed_value: lead.assessed_value,
      total_tax_exposure: lead.total_tax_exposure,
      actual_capital_gain: lead.actual_capital_gain,
      wealth_tier: lead.wealth_tier,
      wealth_signals: lead.wealth_signals,
      related_entities: lead.related_entities,
      has_linkedin: !!lead.decision_maker_linkedin,
      has_email: !!lead.decision_maker_email,
      has_phone: !!lead.decision_maker_phone,
    };

    const sys = `You are a 1031-exchange acquisitions strategist. Classify a verified seller into actionable archetypes for outreach.
Use ONLY the facts provided. Never invent details. If a fact doesn't support a confident label, return null for that field.
We help sellers defer federal + state capital-gains and depreciation-recapture tax via a 1031 exchange into LAS VEGAS replacement property (no NV state income tax, strong rental demand, multifamily / industrial / triple-net retail inventory).`;

    const user = `FACTS:\n${JSON.stringify(facts, null, 2)}\n\nReturn ONLY a JSON object with these keys (use null when unsure):
{
  "personality_type": "one of: analytical, driver, expressive, amiable | null",
  "motivation_type": "one of: tax_avoidance, portfolio_diversification, estate_planning, cash_out_partial, retirement_simplification, distressed_exit | null",
  "preferred_channel": "one of: email, phone, linkedin, mail | null",
  "pitch_angle": "one short sentence: the single most resonant hook for this seller, tied to a specific fact",
  "lv_property_recommendation": "one short sentence: which LV asset class fits (e.g. 'Class B multifamily in Henderson, similar cap rate, simpler management')",
  "profiler_summary": "2 sentences: archetype + why this profile + how to open the conversation"
}`;

    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 30_000);
    let r: Response;
    try {
      r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${aiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: aiModel,
          messages: [{ role: "system", content: sys }, { role: "user", content: user }],
          response_format: { type: "json_object" },
        }),
        signal: ctrl.signal,
      });
    } finally { clearTimeout(tid); }

    if (!r.ok) {
      const txt = await r.text();
      console.error("profile-seller AI error", r.status, txt);
      return finishJob(supabase, jobId, `AI gateway error ${r.status}`, true);
    }

    const data = await r.json();
    const raw = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: any = {};
    try { parsed = JSON.parse(raw); } catch { return finishJob(supabase, jobId, "AI returned non-JSON", true); }

    const oneOf = (v: any, allowed: string[]) =>
      typeof v === "string" && allowed.includes(v) ? v : null;
    const text = (v: any) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);

    const update = {
      personality_type: oneOf(parsed.personality_type, ["analytical", "driver", "expressive", "amiable"]),
      motivation_type: oneOf(parsed.motivation_type, [
        "tax_avoidance", "portfolio_diversification", "estate_planning",
        "cash_out_partial", "retirement_simplification", "distressed_exit",
      ]),
      preferred_channel: oneOf(parsed.preferred_channel, ["email", "phone", "linkedin", "mail"]),
      pitch_angle: text(parsed.pitch_angle),
      lv_property_recommendation: text(parsed.lv_property_recommendation),
      profiler_summary: text(parsed.profiler_summary),
      updated_at: new Date().toISOString(),
    };

    await supabase.from("leads").update(update).eq("id", leadId);

    await supabase.from("lead_activities").insert({
      lead_id: leadId,
      kind: "profiler",
      summary: `Profiled · ${update.personality_type ?? "?"}/${update.motivation_type ?? "?"} · prefers ${update.preferred_channel ?? "?"}`,
      payload: update,
    });

    // Refresh brief now that profile is richer (24h cooldown, skip if brief already fresh)
    await enqueueOnce(supabase, "lead_brief", leadId, {
      priority: 78, cooldownHours: 24,
    });

    if (jobId) {
      await supabase.from("pipeline_jobs").update({
        status: "done", finished_at: new Date().toISOString(),
        result: { ok: true, ...update },
      }).eq("id", jobId);
    }

    return new Response(JSON.stringify({ ok: true, profile: update }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return jsonErr(e?.message ?? "unknown error", 500);
  }
});

async function finishJob(supabase: any, jobId: string | undefined, msg: string, fail = false) {
  if (jobId) {
    await supabase.from("pipeline_jobs").update({
      status: fail ? "failed" : "done",
      finished_at: new Date().toISOString(),
      last_error: fail ? msg : null,
    }).eq("id", jobId);
  }
  return new Response(JSON.stringify({ ok: !fail, error: fail ? msg : undefined }), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function jsonErr(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
