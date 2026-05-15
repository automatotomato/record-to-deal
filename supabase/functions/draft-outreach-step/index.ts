// draft-outreach-step: works one step of a lead's outreach sequence.
// Generates AI-personalized content per channel (email, linkedin, phone_task,
// email_advisor), records it in outreach_touches (and outreach_emails for
// email channels), then advances the lead's outreach_step_index +
// outreach_next_step_at to the next step's scheduled time.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const AI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";

function fmtMoney(n: number | null | undefined): string {
  if (!n) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${n}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const aiKey = Deno.env.get("OPENAI_API_KEY");

  try {
    const body = await req.json().catch(() => ({}));
    let leadId = body?.lead_id;
    const jobId = body?.job_id;
    if (!leadId && jobId) {
      const { data: job } = await supabase.from("pipeline_jobs").select("lead_id").eq("id", jobId).maybeSingle();
      leadId = job?.lead_id ?? null;
    }
    if (!leadId) return done(supabase, jobId, { error: "lead_id required" }, true);

    const { data: lead } = await supabase.from("leads").select("*").eq("id", leadId).maybeSingle();
    if (!lead) return done(supabase, jobId, { error: "lead not found" }, true);
    if (!lead.outreach_sequence_id) return done(supabase, jobId, { skipped: "no sequence assigned" });
    if (lead.tier === "DISQUALIFIED" || lead.pipeline_stage === "expired" || lead.pipeline_stage === "disqualified") {
      return done(supabase, jobId, { skipped: "lead disqualified/expired" });
    }

    const stepIndex = (lead.outreach_step_index ?? 0) + 1; // step indexes are 1-based in DB
    const { data: steps } = await supabase
      .from("outreach_steps")
      .select("*")
      .eq("sequence_id", lead.outreach_sequence_id)
      .order("step_index", { ascending: true });
    if (!steps?.length) return done(supabase, jobId, { error: "no steps" }, true);

    const currentStep = steps.find((s: any) => s.step_index === stepIndex);
    if (!currentStep) {
      // Sequence complete
      await supabase.from("leads").update({
        outreach_next_step_at: null,
        updated_at: new Date().toISOString(),
      }).eq("id", leadId);
      await supabase.from("lead_activities").insert({
        lead_id: leadId, kind: "sequence_complete",
        summary: `Outreach sequence complete (${steps.length} steps)`,
      });
      return done(supabase, jobId, { complete: true });
    }

    // Skip steps that need a contact channel we don't have
    const needsEmail = currentStep.channel === "email" || currentStep.channel === "email_advisor";
    if (needsEmail && !lead.decision_maker_email && !lead.contact_email) {
      // Skip and move on
      return advanceAndDone(supabase, leadId, lead, steps, stepIndex, jobId, "skipped_no_email");
    }
    if (currentStep.channel === "linkedin" && !lead.decision_maker_linkedin) {
      return advanceAndDone(supabase, leadId, lead, steps, stepIndex, jobId, "skipped_no_linkedin");
    }

    const dmName = lead.decision_maker_name ?? lead.owner_name ?? "there";
    const firstName = String(dmName).split(/\s+/)[0];
    const ctx = {
      first_name: firstName,
      owner_name: lead.owner_name,
      owner_type: lead.owner_type,
      property: `${lead.property_address ?? "?"} · ${lead.property_city ?? ""}, ${lead.state ?? ""}`,
      property_type: lead.property_type,
      sale_price: fmtMoney(lead.sale_price),
      sale_date: lead.sale_date,
      tax_exposure: fmtMoney(lead.total_tax_exposure),
      state: lead.state,
      tier: lead.tier,
      wealth_tier: lead.wealth_tier,
      wealth_signals: lead.wealth_signals,
      personality_type: lead.personality_type,
      motivation_type: lead.motivation_type,
      pitch_angle: lead.pitch_angle,
      lv_property_recommendation: lead.lv_property_recommendation,
      step_template: currentStep.template_key,
      step_notes: currentStep.notes,
      step_index: currentStep.step_index,
      channel: currentStep.channel,
    };

    const channelInstructions: Record<string, string> = {
      email: `Return JSON: { "subject": "<60 char personalized subject", "body": "120-180 word email, plain text, signed: -The team / 1031 Exchange Elite" }. Lead with the pitch_angle if present, otherwise tax_exposure + Las Vegas replacement angle. Step ${currentStep.step_index} of the sequence — vary tone from prior steps.`,
      linkedin: `Return JSON: { "body": "280 char LinkedIn connection-request blurb, no subject line" }. Reference the recent sale + 1031/Las Vegas angle in plain conversational tone.`,
      phone_task: `Return JSON: { "subject": "Phone talking points for ${firstName}", "body": "5–7 short bullet talking points an agent will read on a cold call. Open, anchor on the tax_exposure and pitch_angle, anticipate one objection, close with a calendar ask. Plain text, dashes for bullets." }`,
      email_advisor: `Return JSON: { "subject": "<60 char subject for the seller's attorney/CPA", "body": "120-180 word email addressed to a tax professional, framing the 1031 opportunity for their client without naming the client. Sign as -The team / 1031 Exchange Elite." }`,
    };

    let subject = "";
    let bodyText = "";
    let templated = true;

    if (aiKey) {
      try {
        const r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${aiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: AI_MODEL,
            messages: [
              { role: "system", content: "You are a 1031-exchange acquisitions analyst writing one touch in a multi-step outreach sequence. Use ONLY the verified facts. Never invent details. Output JSON only." },
              { role: "user", content: `${JSON.stringify(ctx, null, 2)}\n\n${channelInstructions[currentStep.channel] ?? channelInstructions.email}` },
            ],
            response_format: { type: "json_object" },
          }),
          signal: AbortSignal.timeout(30_000),
        });
        if (r.ok) {
          const data = await r.json();
          const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
          if (parsed.body) {
            subject = parsed.subject ?? "";
            bodyText = parsed.body;
            templated = false;
          }
        }
      } catch (e) { console.warn("AI step draft failed", e); }
    }

    if (!bodyText) {
      // Fallback templates
      subject = `Step ${currentStep.step_index} · ${currentStep.template_key}`;
      bodyText = `Hi ${firstName},\n\nFollowing up on ${ctx.property}. ${lead.pitch_angle ?? `A 1031 exchange into Las Vegas could defer ~${ctx.tax_exposure} in tax.`}\n\n– The team\n1031 Exchange Elite`;
    }

    // Persist touch
    let outreachEmailId: string | null = null;
    if (currentStep.channel === "email" || currentStep.channel === "email_advisor") {
      // Supersede prior drafts only on the very first step
      if (currentStep.step_index === 1) {
        await supabase.from("outreach_emails")
          .update({ status: "superseded" })
          .eq("lead_id", leadId)
          .eq("status", "draft");
      }
      const { data: emailRow } = await supabase
        .from("outreach_emails")
        .insert({
          lead_id: leadId,
          subject,
          body: bodyText,
          to_email: currentStep.channel === "email_advisor" ? null : (lead.decision_maker_email ?? lead.contact_email ?? null),
          status: "draft",
        })
        .select("id")
        .single();
      outreachEmailId = emailRow?.id ?? null;
    }

    await supabase.from("outreach_touches").insert({
      lead_id: leadId,
      sequence_id: lead.outreach_sequence_id,
      step_index: currentStep.step_index,
      channel: currentStep.channel,
      template_key: currentStep.template_key,
      outreach_email_id: outreachEmailId,
      status: "drafted",
      payload: { subject, body: bodyText, templated },
    });

    await supabase.from("lead_activities").insert({
      lead_id: leadId,
      kind: "outreach_step_drafted",
      summary: `Step ${currentStep.step_index} (${currentStep.channel}) drafted${templated ? " (template)" : ""}`,
      payload: { step_index: currentStep.step_index, channel: currentStep.channel, template_key: currentStep.template_key },
    });

    return advanceAndDone(supabase, leadId, lead, steps, stepIndex, jobId, "drafted");
  } catch (e: any) {
    return done(supabase, undefined, { error: e?.message ?? "unknown" }, true);
  }

  function done(_sb: any, jobId2: string | undefined, payload: any, fail = false) {
    return finishJob(supabase, jobId2, payload, fail);
  }
});

async function advanceAndDone(
  supabase: any, leadId: string, lead: any, steps: any[], currentIndex: number, jobId: string | undefined, status: string,
) {
  const next = steps.find((s: any) => s.step_index === currentIndex + 1);
  const nextAt = next ? new Date(Date.now() + (next.delay_days || 0) * 86_400_000).toISOString() : null;

  await supabase.from("leads").update({
    outreach_step_index: currentIndex,
    outreach_next_step_at: nextAt,
    last_touchpoint_at: new Date().toISOString(),
    last_touchpoint_kind: `outreach_step_${currentIndex}`,
    updated_at: new Date().toISOString(),
  }).eq("id", leadId);

  return finishJob(supabase, jobId, { status, advanced_to: currentIndex, next_at: nextAt });
}

async function finishJob(supabase: any, jobId: string | undefined, payload: any, fail = false) {
  if (jobId) {
    await supabase.from("pipeline_jobs").update({
      status: fail ? "failed" : "done",
      finished_at: new Date().toISOString(),
      last_error: fail ? (payload?.error ?? "failed") : null,
      result: payload,
    }).eq("id", jobId);
  }
  return new Response(JSON.stringify({ ok: !fail, ...payload }), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
