// qualify-lead worker: applies hard filters + scores ONE lead, writes tier,
// score, qualification_reason, days_since_sale, has_contact flags. Advances
// pipeline_stage to qualified / needs_review / disqualified. On qualify, it
// enqueues an enrich_contact job. Job kind: qualify_lead.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FEDERAL_LTCG_RATE = 0.238;
// Default seller cost basis when assessed_value is missing — 40% of sale price.
// Real basis is usually unknown for off-market sellers; this errs on the side of
// implying a meaningful gain so we don't under-pitch tax exposure.
const DEFAULT_BASIS_PCT = 0.40;

interface StateRate {
  state: string;
  ltcg_rate: number;
  surcharge: number;
  is_high_tax: boolean;
  is_target: boolean;
  priority_rank: number;
}
type Tier = "CRITICAL" | "URGENT" | "ACTIVE" | "FOLLOW_UP" | "EXPIRED" | "DISQUALIFIED";

function daysSince(d?: string | null): number | null {
  if (!d) return null;
  const t = new Date(d).getTime();
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function isOutreachContact(l: any): boolean {
  const okEmail = l.decision_maker_email && /[^@\s]+@[^@\s]+\.[a-z]{2,}/i.test(l.decision_maker_email)
    && !/email_not_unlocked|domain\.com$|@apollo-locked/i.test(l.decision_maker_email);
  const okPhone = (l.decision_maker_phone || l.contact_phone) && String(l.decision_maker_phone || l.contact_phone).replace(/\D/g, "").length >= 10;
  const okWeb = l.company_website && /^https?:\/\//i.test(l.company_website);
  const okLi = l.decision_maker_linkedin || l.contact_linkedin;
  return !!(okEmail || okPhone || okWeb || okLi);
}

function isAnyContact(l: any): boolean {
  if (isOutreachContact(l)) return true;
  if (l.mailing_address && norm(l.mailing_address) !== norm(l.property_address)) return true;
  return false;
}

const norm = (s: string | null | undefined) =>
  (s ?? "").toString().trim().toUpperCase().replace(/\s+/g, " ").replace(/[.,]/g, "");

const INVESTMENT_TYPES = new Set(["Multifamily", "Commercial", "Industrial", "Mixed"]);
const ENTITY_OWNERS = new Set(["LLC", "Corporation", "Trust", "Estate"]);

interface ScoreOut {
  score: number;
  tier: Tier;
  is_urgent: boolean;
  reason: string;
  breakdown: Record<string, number>;
  days_since_sale: number | null;
  state_tax_rate: number | null;
  fed_capital_gains_estimate: number | null;
  state_capital_gains_estimate: number | null;
  total_tax_exposure: number | null;
  actual_capital_gain: number | null;
  effective_tax_rate: number | null;
  disqualified: boolean;
  needs_review: boolean;
}

function scoreLead(lead: any, stateRate: StateRate | null): ScoreOut {
  const reasons: string[] = [];
  const breakdown: Record<string, number> = {};
  const days = daysSince(lead.sale_date ?? lead.deed_date);
  const ownerType = lead.owner_type ?? "Unknown";
  const propType = lead.property_type ?? "Unknown";
  const sp = lead.sale_price ?? 0;
  const isHighTax = !!stateRate?.is_high_tax;
  const addr = (lead.property_address ?? "").toUpperCase();
  const isCondoApt = /\b(APT|UNIT|#|STE|SUITE)\b/.test(addr);

  // --- Hard disqualifiers ---
  const trig = lead.trigger_event ?? "";
  const acceptedTriggers = new Set(["sale_recorded", "deed_recorded", "transfer_recorded"]);
  if (!acceptedTriggers.has(trig) || !lead.sale_date) {
    return disq("No confirmed sale/deed/transfer event with a sale date.", days, stateRate);
  }
  if (!lead.property_address) {
    return needsReview("Property address could not be resolved.", days, stateRate);
  }
  if (sp === 0) return disq("Disqualified: $0 transfer (likely quitclaim or non-arms-length).", days, stateRate);

  // Hard 1031 floor: individual owner of an unclear/SFR property under $750k will
  // essentially never do a 1031. Drop those before they pollute the pipeline.
  if (ownerType === "Individual" && (propType === "SFR" || propType === "Unknown") && sp > 0 && sp < 750_000) {
    return disq("Disqualified: small individual-owned residential sale below 1031 viability threshold.", days, stateRate);
  }

  // Address state must match county state
  const stateMatch = addr.match(/\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/);
  if (stateMatch && stateMatch[1] !== lead.state) {
    return disq(`Disqualified: address state ${stateMatch[1]} does not match county state ${lead.state}.`, days, stateRate);
  }

  // Owner-occupied / SFR-Individual filters
  const looksResidential = propType === "SFR" || propType === "Unknown" || isCondoApt;
  if (looksResidential && ownerType === "Individual" && norm(lead.mailing_address) === norm(lead.property_address)) {
    return disq("Disqualified: owner-occupied residential property.", days, stateRate);
  }
  if (looksResidential && ownerType === "Individual") {
    // Allow only if absentee (mailing zip != property zip)
    const absentee = lead.mailing_address && lead.property_zip
      && !norm(lead.mailing_address).includes(lead.property_zip);
    if (!absentee) {
      return disq("Disqualified: SFR/condo owned by an individual without absentee signal.", days, stateRate);
    }
  }
  // Land threshold
  if (propType === "Land" && sp < 250_000) {
    return disq("Disqualified: land sale under the $250k investment threshold.", days, stateRate);
  }

  // Sale recency window — only leads inside the 90-day actionable window
  if (days != null && days > 90) {
    return {
      score: 0, tier: "EXPIRED", is_urgent: false,
      reason: `Expired: sale ${days} days ago is outside the 90-day actionable window.`,
      breakdown: {}, days_since_sale: days,
      state_tax_rate: stateRate ? stateRate.ltcg_rate + stateRate.surcharge : null,
      fed_capital_gains_estimate: null, state_capital_gains_estimate: null,
      total_tax_exposure: null, disqualified: true, needs_review: false,
    };
  }


  // --- Scoring (0-100) ---
  // Sale recency (max 25)
  let recency = 0;
  if (days != null) {
    if (days <= 30) recency = 22;
    else if (days <= 45) recency = 25;
    else if (days <= 90) recency = 12;
    else if (days <= 180) recency = 5;
  }
  breakdown.sale_recency = recency;
  if (days != null) reasons.push(`sold ${days} days ago`);

  // Property type (max 15)
  let pt = 0;
  if (propType === "Commercial" || propType === "Multifamily") pt = 15;
  else if (propType === "Industrial" || propType === "Mixed") pt = 12;
  else if (propType === "Land") pt = 8;
  else if (ENTITY_OWNERS.has(ownerType)) pt = 6;
  breakdown.property_type = pt;
  reasons.push(`property type ${propType.toLowerCase()}`);

  // Owner type (max 15)
  let ot = 0;
  if (ENTITY_OWNERS.has(ownerType)) ot = 15;
  else {
    const absentee = lead.mailing_address && lead.property_zip
      && !norm(lead.mailing_address).includes(lead.property_zip);
    if (absentee) ot = 10;
  }
  breakdown.owner_type = ot;
  reasons.push(`owner ${ownerType === "LLC" ? "is an LLC" : ownerType.toLowerCase()}`);

  // Sale price (max 15)
  let ps = 0;
  if (sp >= 5_000_000) ps = 15;
  else if (sp >= 1_000_000) ps = 10;
  else if (sp >= 500_000) ps = 6;
  else ps = 2;
  breakdown.sale_price = ps;
  if (sp > 0) reasons.push(`sale price $${Math.round(sp / 1000)}k`);

  // High-tax state (max 15) — bumped from 10. Federal-only target (FL/TX) gets +8.
  let ht = 0;
  if (isHighTax) ht = 15;
  else if (stateRate?.is_target) ht = 8;
  breakdown.high_tax_state = ht;
  if (isHighTax) reasons.push(`in ${lead.state} (high state tax)`);
  else if (stateRate?.is_target) reasons.push(`in ${lead.state} (federal-only target market)`);

  // Outreach contactability (max 15)
  let cc = 0;
  if (lead.decision_maker_email && isOutreachContact(lead)) cc += 8;
  if (lead.decision_maker_phone || lead.contact_phone) cc += 4;
  if (lead.company_website || lead.decision_maker_linkedin || lead.contact_linkedin) cc += 3;
  cc = Math.min(15, cc);
  breakdown.contactability = cc;

  // Source confidence (max 5)
  const fromCounty = (lead.data_sources ?? []).some((s: string) => /county|attom/i.test(s));
  const sc = fromCounty ? 5 : 2;
  breakdown.source_confidence = sc;

  const total = recency + pt + ot + ps + ht + cc + sc;

  // --- Tier from sale-recency window + state targeting ---
  // URGENT now REQUIRES is_high_tax. Federal-only targets (FL/TX) max out at CRITICAL.
  let tier: Tier = "EXPIRED";
  let urgent = false;
  const strongFit = INVESTMENT_TYPES.has(propType) || ENTITY_OWNERS.has(ownerType) || sp >= 1_000_000;
  if (days != null) {
    if (isHighTax && days <= 30 && sp >= 1_000_000 && strongFit) {
      tier = "URGENT"; urgent = true;
    } else if (isHighTax && days <= 45 && strongFit) {
      tier = "CRITICAL"; urgent = true;
    } else if (stateRate?.is_target && days <= 30 && sp >= 1_000_000 && strongFit) {
      // Federal-only target market with very fresh + large sale → CRITICAL, not URGENT
      tier = "CRITICAL"; urgent = false;
    } else if (days <= 90 && strongFit) {
      tier = "ACTIVE";
    } else if (days <= 180) {
      tier = "FOLLOW_UP";
    } else {
      tier = "EXPIRED";
    }
  }

  // Tax math — fix: actual_capital_gain is the GAIN (sale - basis), not the tax owed.
  // capital_gains_estimate kept as alias for actual_capital_gain for back-compat.
  // total_tax_exposure stays as fed + state tax owed.
  const stateTotalRate = stateRate ? stateRate.ltcg_rate + stateRate.surcharge : null;
  const fmv = lead.assessed_value ?? 0;
  let basis = 0;
  if (fmv > 0 && sp > 0 && fmv < sp) basis = fmv;          // assessed value as basis
  else if (sp > 0) basis = Math.round(sp * DEFAULT_BASIS_PCT);
  const gain = sp > basis ? sp - basis : 0;
  const fed = gain > 0 ? Math.round(gain * FEDERAL_LTCG_RATE) : null;
  const stateTax = gain > 0 && stateTotalRate != null ? Math.round(gain * stateTotalRate) : null;
  const totalTax = (fed ?? 0) + (stateTax ?? 0) || null;
  const effectiveRate = gain > 0 && totalTax ? +(totalTax / gain).toFixed(4) : null;

  const reason = `Qualified because ${reasons.join(", ")}.`;
  return {
    score: total, tier, is_urgent: urgent, reason, breakdown,
    days_since_sale: days, state_tax_rate: stateTotalRate,
    fed_capital_gains_estimate: fed, state_capital_gains_estimate: stateTax,
    total_tax_exposure: totalTax,
    actual_capital_gain: gain || null,
    effective_tax_rate: effectiveRate,
    disqualified: false, needs_review: false,
  };
}

function disq(reason: string, days: number | null, sr: StateRate | null): ScoreOut {
  return {
    score: 0, tier: "DISQUALIFIED", is_urgent: false, reason,
    breakdown: {}, days_since_sale: days,
    state_tax_rate: sr ? sr.ltcg_rate + sr.surcharge : null,
    fed_capital_gains_estimate: null, state_capital_gains_estimate: null,
    total_tax_exposure: null, actual_capital_gain: null, effective_tax_rate: null,
    disqualified: true, needs_review: false,
  };
}
function needsReview(reason: string, days: number | null, sr: StateRate | null): ScoreOut {
  return {
    score: 0, tier: "DISQUALIFIED", is_urgent: false, reason,
    breakdown: {}, days_since_sale: days,
    state_tax_rate: sr ? sr.ltcg_rate + sr.surcharge : null,
    fed_capital_gains_estimate: null, state_capital_gains_estimate: null,
    total_tax_exposure: null, actual_capital_gain: null, effective_tax_rate: null,
    disqualified: false, needs_review: true,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: { job_id?: string } = {};
  try { body = await req.json(); } catch (_) {}
  if (!body.job_id) return jsonErr("job_id required", 400);

  const { data: job } = await supabase.from("pipeline_jobs").select("*").eq("id", body.job_id).maybeSingle();
  if (!job) return jsonErr("job not found", 404);
  const leadId = job.lead_id;
  if (!leadId) { await markFailed(supabase, body.job_id, "no lead_id"); return jsonOk({ ok: false }); }

  const { data: lead } = await supabase.from("leads").select("*").eq("id", leadId).maybeSingle();
  if (!lead) { await markFailed(supabase, body.job_id, "lead missing"); return jsonOk({ ok: false }); }

  const { data: rate } = await supabase
    .from("state_tax_rates")
    .select("state, ltcg_rate, surcharge, is_high_tax, is_target, priority_rank")
    .eq("state", lead.state)
    .maybeSingle();

  const r = scoreLead(lead, rate as StateRate | null);
  const stage = r.disqualified ? "disqualified"
    : r.needs_review ? "needs_review"
    : r.tier === "EXPIRED" ? "expired"
    : "qualified";

  // If lead is disqualified or expired (outside 90-day actionable window),
  // purge it entirely — we don't keep a graveyard of unreachable opportunities.
  if (r.disqualified || r.tier === "EXPIRED" || r.tier === "DISQUALIFIED") {
    await supabase.from("lead_activities").delete().eq("lead_id", leadId);
    await supabase.from("lead_touchpoints").delete().eq("lead_id", leadId);
    await supabase.from("outreach_touches").delete().eq("lead_id", leadId);
    await supabase.from("outreach_emails").delete().eq("lead_id", leadId);
    await supabase.from("pipeline_jobs").delete().eq("lead_id", leadId).neq("id", body.job_id);
    await supabase.from("leads").delete().eq("id", leadId);
    await supabase.from("pipeline_jobs").update({
      status: "done", finished_at: new Date().toISOString(),
      result: { tier: r.tier, score: r.score, stage, purged: true, reason: r.reason },
    }).eq("id", body.job_id);
    return jsonOk({ ok: true, tier: r.tier, score: r.score, stage, purged: true });
  }

  await supabase.from("leads").update({
    score: r.score,
    tier: r.tier,
    is_urgent: r.is_urgent,
    qualification_reason: r.reason,
    score_breakdown: r.breakdown,
    days_since_sale: r.days_since_sale,
    state_tax_rate: r.state_tax_rate,
    fed_capital_gains_estimate: r.fed_capital_gains_estimate,
    state_capital_gains_estimate: r.state_capital_gains_estimate,
    capital_gains_estimate: r.actual_capital_gain,
    actual_capital_gain: r.actual_capital_gain,
    total_tax_exposure: r.total_tax_exposure,
    effective_tax_rate: r.effective_tax_rate,
    has_contact: isAnyContact(lead),
    has_outreach_contact: isOutreachContact(lead),
    pipeline_stage: stage,
    updated_at: new Date().toISOString(),
  }).eq("id", leadId);

  await supabase.from("lead_activities").insert({
    lead_id: leadId,
    kind: "qualifier_scored",
    summary: `${r.tier} · score ${r.score}${r.is_urgent ? " · URGENT" : ""}`,
    payload: { reason: r.reason, breakdown: r.breakdown, stage },
  });

  if (stage === "qualified") {
    await supabase.from("pipeline_jobs").insert({
      kind: "enrich_contact", lead_id: leadId,
      priority: r.is_urgent ? 50 : 80,
    });
  }

  await supabase.from("pipeline_jobs").update({
    status: "done", finished_at: new Date().toISOString(),
    result: { tier: r.tier, score: r.score, stage },
  }).eq("id", body.job_id);

  if (stage === "qualified") {
    supabase.functions.invoke("job-dispatcher", { body: { trigger: "qualify_lead_followups" } }).catch(() => {});
  }

  return jsonOk({ ok: true, tier: r.tier, score: r.score, stage });
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
