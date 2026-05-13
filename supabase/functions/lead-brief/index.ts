// lead-brief: generates a plain-English AI summary for a lead explaining
// what was found, why it's a good prospect, and how to approach them.
// Uses Lovable AI Gateway. Stores result on leads.ai_brief.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function fmtMoney(n: number | null | undefined): string {
  if (!n) return "unknown";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${n}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const aiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!aiKey) return jsonErr("LOVABLE_API_KEY missing", 500);

    const body = await req.json().catch(() => ({}));
    const leadId = body?.lead_id;
    if (!leadId) return jsonErr("lead_id required", 400);

    const { data: lead, error } = await supabase.from("leads").select("*").eq("id", leadId).maybeSingle();
    if (error || !lead) return jsonErr("lead not found", 404);

    const facts = {
      property: `${lead.property_address ?? "?"}, ${lead.property_city ?? ""} ${lead.state ?? ""} ${lead.property_zip ?? ""}`.trim(),
      county: lead.county,
      property_type: lead.property_type,
      sale_price: lead.sale_price ? fmtMoney(lead.sale_price) : null,
      sale_date: lead.sale_date,
      days_since_sale: lead.days_since_sale,
      ownership_years: lead.ownership_years,
      assessed_value: lead.assessed_value ? fmtMoney(lead.assessed_value) : null,
      owner_name: lead.owner_name,
      owner_type: lead.owner_type,
      mailing_address: lead.mailing_address,
      decision_maker_name: lead.decision_maker_name,
      decision_maker_role: lead.decision_maker_role,
      decision_maker_email: lead.decision_maker_email,
      decision_maker_phone: lead.decision_maker_phone,
      decision_maker_linkedin: lead.decision_maker_linkedin,
      company_website: lead.company_website,
      tier: lead.tier,
      score: lead.score,
      is_urgent: lead.is_urgent,
      capital_gains_estimate: lead.capital_gains_estimate ? fmtMoney(lead.capital_gains_estimate) : null,
      depreciation_recapture_est: lead.depreciation_recapture_est ? fmtMoney(lead.depreciation_recapture_est) : null,
      total_tax_exposure: lead.total_tax_exposure ? fmtMoney(lead.total_tax_exposure) : null,
      state_tax_rate: lead.state_tax_rate,
      personality_type: lead.personality_type,
      motivation_type: lead.motivation_type,
      preferred_channel: lead.preferred_channel,
      pitch_angle: lead.pitch_angle,
      lv_property_recommendation: lead.lv_property_recommendation,
      wealth_signals: lead.wealth_signals,
      qualification_reason: lead.qualification_reason,
      data_sources: lead.data_sources,
      related_entities: lead.related_entities,
    };

    const sys = `You are a senior 1031-exchange acquisitions analyst writing an internal lead brief for a sales agent.
You will be given verified facts about a recently-sold property and its owner. Use ONLY the facts provided — never invent names, numbers, or details.
The agent's offer: help the seller defer federal + state capital-gains and depreciation-recapture tax via a 1031 exchange into Las Vegas (no state income tax) replacement property within their 45-day identification window.
Return concise, specific, agent-ready prose. No fluff, no marketing language. If a section has no real basis in the facts, return an empty string for that section.`;

    const user = `FACTS:\n${JSON.stringify(facts, null, 2)}\n\nReturn ONLY a JSON object with these keys:
{
  "summary": "3–4 sentences: what the agent uncovered about this property and owner. Reference specific facts (address, sale price, owner). Plain English.",
  "why_good": "3–5 bullet-style sentences explaining why this is a strong 1031 lead. Tie each reason to a specific fact (tax exposure, urgency, owner type, holding period, wealth signal). If the lead is weak, say so honestly.",
  "approach": "3–5 sentences: how the agent should reach out. Channel, tone, what to lead with, what objection to anticipate. Reference personality/motivation if known."
}`;

    const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${aiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (!r.ok) {
      const txt = await r.text();
      if (r.status === 429) return jsonErr("Rate limited — try again shortly", 429);
      if (r.status === 402) return jsonErr("AI credits exhausted — add credits in Workspace settings", 402);
      return jsonErr(`AI gateway: ${txt}`, 500);
    }

    const data = await r.json();
    const raw = data?.choices?.[0]?.message?.content ?? "{}";
    let brief: { summary?: string; why_good?: string; approach?: string } = {};
    try { brief = JSON.parse(raw); } catch { return jsonErr("AI returned non-JSON", 500); }

    const cleaned = {
      summary: (brief.summary ?? "").trim(),
      why_good: (brief.why_good ?? "").trim(),
      approach: (brief.approach ?? "").trim(),
    };

    await supabase.from("leads").update({
      ai_brief: cleaned,
      ai_brief_generated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", leadId);

    return new Response(JSON.stringify({ ok: true, brief: cleaned }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return jsonErr(e?.message ?? "unknown error", 500);
  }
});

function jsonErr(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
