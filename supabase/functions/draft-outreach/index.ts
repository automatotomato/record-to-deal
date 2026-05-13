// draft-outreach worker: takes an ENRICHED lead with has_outreach_contact=true,
// generates a personalized email via OpenAI, writes to outreach_emails as a
// draft, and advances pipeline_stage to ready. Job kind: draft_outreach.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const AI_URL = "https://api.openai.com/v1/chat/completions";
const AI_MODEL = "gpt-4o-mini";

function fmtMoney(n: number | null | undefined): string {
  if (!n) return "unknown";
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
  const openaiKey = Deno.env.get("OPENAI_API_KEY");

  let body: { job_id?: string } = {};
  try { body = await req.json(); } catch (_) {}
  if (!body.job_id) return jsonErr("job_id required", 400);

  const { data: job } = await supabase.from("pipeline_jobs").select("*").eq("id", body.job_id).maybeSingle();
  if (!job) return jsonErr("job not found", 404);
  const leadId = job.lead_id;
  if (!leadId) { await markFailed(supabase, body.job_id, "no lead_id"); return jsonOk({ ok: false }); }

  const { data: lead } = await supabase.from("leads").select("*").eq("id", leadId).maybeSingle();
  if (!lead) { await markFailed(supabase, body.job_id, "lead missing"); return jsonOk({ ok: false }); }

  const dmName = lead.decision_maker_name ?? lead.owner_name;
  const greeting = dmName ? `Hi ${String(dmName).split(/\s+/)[0]},` : "Hello,";
  const stateLabel = lead.state ?? "your state";
  const propLabel = lead.property_type === "Multifamily" ? "multifamily property"
    : lead.property_type === "Commercial" ? "commercial property"
    : lead.property_type === "Industrial" ? "industrial property"
    : lead.property_type === "Land" ? "land parcel"
    : "investment property";
  const addrLabel = lead.property_address ?? `your ${stateLabel} ${propLabel}`;

  // Templated fallback (always usable)
  const taxLine = lead.total_tax_exposure && lead.total_tax_exposure > 100_000
    ? ` Public records suggest a federal + ${stateLabel} capital-gains exposure near ${fmtMoney(lead.total_tax_exposure)} on this sale — a 1031 exchange into Las Vegas (no state income tax) could defer most of that.`
    : ` A 1031 exchange into Las Vegas (no state income tax) could defer the capital-gains and depreciation-recapture liability on this sale.`;
  let subject = `Quick question on ${addrLabel.split(",")[0]}`;
  let bodyText = `${greeting}

Saw the recent sale of ${addrLabel}.${taxLine}

We help sellers identify replacement properties inside the 45-day window — happy to share a shortlist of Las Vegas multifamily and NNN options that match your basis.

Worth a 15-minute call this week?

– The team
1031 Exchange Elite`;
  let templated = true;

  // Try AI rewrite if we have a key
  if (openaiKey) {
    try {
      const ctx = `
Property: ${lead.property_address ?? "?"} · ${lead.property_city ?? ""}, ${lead.state ?? ""} ${lead.property_zip ?? ""}
Type: ${lead.property_type}
Owner: ${lead.owner_name} (${lead.owner_type})
Decision maker: ${dmName ?? "unknown"}${lead.decision_maker_role ? ` (${lead.decision_maker_role})` : ""}
Sale: ${lead.sale_price ? `$${lead.sale_price.toLocaleString()}` : "?"} on ${lead.sale_date ?? "?"}
Days since sale: ${lead.days_since_sale ?? "?"}
Tier: ${lead.tier}
Estimated tax exposure: ${fmtMoney(lead.total_tax_exposure)}
Qualification reason: ${lead.qualification_reason ?? ""}`.trim();

      const aiResp = await fetch(AI_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: [
            { role: "system", content: "You are a 1031-exchange outreach analyst. Draft a tight, personalized cold email offering a 1031 consultation into Las Vegas property. The owner data is verified — do not invent details. Return ONLY JSON." },
            { role: "user", content: `${ctx}\n\nReturn JSON: { "subject": "personalized subject under 60 chars", "body": "120–180 words plain text, signed -The team / 1031 Exchange Elite" }` },
          ],
          response_format: { type: "json_object" },
        }),
      });
      if (aiResp.ok) {
        const data = await aiResp.json();
        const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
        if (parsed.subject && parsed.body) {
          subject = parsed.subject;
          bodyText = parsed.body;
          templated = false;
        }
      }
    } catch (e) {
      console.warn("AI draft failed, using template:", e);
    }
  }

  // Supersede prior drafts
  await supabase.from("outreach_emails")
    .update({ status: "superseded" })
    .eq("lead_id", leadId)
    .eq("status", "draft");

  const { data: emailRow, error: emErr } = await supabase
    .from("outreach_emails")
    .insert({
      lead_id: leadId,
      subject,
      body: bodyText,
      to_email: lead.decision_maker_email ?? null,
      status: "draft",
    })
    .select("id")
    .single();

  if (emErr) {
    await markFailed(supabase, body.job_id, `draft insert: ${emErr.message}`);
    return jsonErr(emErr.message, 500);
  }

  // Source proof: any of these fields → ready
  const hasProof = !!(lead.source_record_url || lead.smarty_key
    || lead.enrichment_payload?.county_record_id || lead.enrichment_payload?.deed_reference);
  const newStage = hasProof ? "ready" : "needs_review";

  await supabase.from("leads").update({
    pipeline_stage: newStage,
    updated_at: new Date().toISOString(),
  }).eq("id", leadId);

  await supabase.from("lead_activities").insert({
    lead_id: leadId,
    kind: "email_drafted",
    summary: templated ? "Templated draft created" : "AI-personalized draft created",
    payload: { email_id: emailRow.id, stage: newStage },
  });

  await supabase.from("pipeline_jobs").update({
    status: "done", finished_at: new Date().toISOString(),
    result: { email_id: emailRow.id, stage: newStage },
  }).eq("id", body.job_id);

  return jsonOk({ ok: true, email_id: emailRow.id, stage: newStage });
});

function jsonOk(b: unknown) {
  return new Response(JSON.stringify(b), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function jsonErr(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
async function markFailed(supabase: any, jobId: string, msg: string) {
  await supabase.from("pipeline_jobs").update({
    status: "failed", finished_at: new Date().toISOString(), last_error: msg,
  }).eq("id", jobId);
}
