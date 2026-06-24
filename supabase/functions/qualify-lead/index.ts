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
  city_surcharges?: Record<string, number> | null;
}

// Match the lead's property_city (and a few address fallbacks) against the
// state_tax_rates.city_surcharges JSON map. Keys are upper-case city names.
function cityExtraRate(lead: any, sr: StateRate | null): { city: string | null; rate: number } {
  if (!sr?.city_surcharges) return { city: null, rate: 0 };
  const map = sr.city_surcharges;
  const cands: string[] = [];
  if (lead.property_city) cands.push(String(lead.property_city));
  if (lead.property_address) {
    const m = String(lead.property_address).match(/,\s*([^,]+),\s*[A-Z]{2}\b/);
    if (m) cands.push(m[1]);
  }
  for (const raw of cands) {
    const key = raw.trim().toUpperCase();
    if (key in map && typeof map[key] === "number") {
      return { city: key, rate: map[key] };
    }
  }
  return { city: null, rate: 0 };
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

const INVESTMENT_TYPES = new Set(["Multifamily", "Commercial", "Industrial", "Mixed", "Retail", "Office"]);
const ENTITY_OWNERS = new Set(["LLC", "Corporation", "Trust", "Estate", "LP", "LLP", "Partnership"]);

function looksOwnerOccupied(lead: any, propType: string): boolean {
  if (lead.owner_type !== "Individual") return false;
  if (!lead.mailing_address || !lead.property_address) return false;
  if (propType !== "SFR" && propType !== "Condo" && propType !== "Unknown") return false;
  return norm(lead.mailing_address) === norm(lead.property_address);
}

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
  city_surcharge_applied: { city: string; rate: number } | null;
  days_until_45_deadline: number | null;
  days_until_180_deadline: number | null;
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
  const cityBoost = cityExtraRate(lead, stateRate);
  const daysTo45 = days != null ? 45 - days : null;
  const daysTo180 = days != null ? 180 - days : null;

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

  // Geography filter: we BROKER sellers from other states INTO Nevada.
  // Nevada sellers already enjoy a 0% state income tax — there is no
  // state-tax arbitrage to pitch, so they are out of scope.
  if (lead.state === "NV") {
    return disq("Disqualified: Nevada seller — no out-of-state tax arbitrage to pitch.", days, stateRate);
  }

  // Commercial-only thesis: we only chase commercial 1031s. Residential
  // (SFR, condo, owner-occupied) is dropped at the gate, regardless of
  // absentee status.
  if (propType === "SFR" || isCondoApt) {
    return disq("Disqualified: residential property (SFR/condo) — out of commercial 1031 scope.", days, stateRate);
  }
  if (looksOwnerOccupied(lead, propType)) {
    return disq("Disqualified: owner-occupied property.", days, stateRate);
  }
  // Require commercial-class property OR an entity owner with a real-money sale.
  const commercialClass = INVESTMENT_TYPES.has(propType);
  const entityWithSize = ENTITY_OWNERS.has(ownerType) && sp >= 750_000;
  if (!commercialClass && !entityWithSize) {
    return disq("Disqualified: not a commercial-class asset and not an entity-owned sale ≥ $750k.", days, stateRate);
  }
  // Land floor raised from $250k → $1M to keep only investment-grade parcels.
  if (propType === "Land" && sp < 1_000_000) {
    return disq("Disqualified: land sale under the $1M investment threshold.", days, stateRate);
  }

  // Address state must match county state (sanity check on geocoding)
  const stateMatch = addr.match(/\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/);
  if (stateMatch && stateMatch[1] !== lead.state) {
    return disq(`Disqualified: address state ${stateMatch[1]} does not match county state ${lead.state}.`, days, stateRate);
  }

  // Sale recency window — only leads inside the 90-day actionable window
  if (days != null && days > 90) {
    return {
      score: 0, tier: "EXPIRED", is_urgent: false,
      reason: `Expired: sale ${days} days ago is outside the 90-day actionable window.`,
      breakdown: {}, days_since_sale: days,
      state_tax_rate: stateRate ? stateRate.ltcg_rate + stateRate.surcharge + cityBoost.rate : null,
      fed_capital_gains_estimate: null, state_capital_gains_estimate: null,
      total_tax_exposure: null,
      actual_capital_gain: null, effective_tax_rate: null,
      disqualified: true, needs_review: false,
      city_surcharge_applied: cityBoost.city ? { city: cityBoost.city, rate: cityBoost.rate } : null,
      days_until_45_deadline: daysTo45, days_until_180_deadline: daysTo180,
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

  // Property type (max 25) — commercial-class assets dominate
  let pt = 0;
  if (propType === "Commercial" || propType === "Multifamily" || propType === "Industrial") pt = 25;
  else if (propType === "Mixed" || propType === "Retail" || propType === "Office") pt = 20;
  else if (propType === "Land") pt = 10;
  else if (ENTITY_OWNERS.has(ownerType)) pt = 12;
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

  // State-tax arbitrage (max 20) — the bigger their home-state tax bill,
  // the bigger the Nevada (0% state income tax) upside we can pitch.
  let ht = 0;
  const HIGH_ARBITRAGE = new Set(["CA", "NY", "NJ", "OR", "HI"]);
  const LOW_TAX_NO_PITCH = new Set(["TX", "FL", "WA", "TN", "SD", "WY", "AK", "NH"]);
  if (HIGH_ARBITRAGE.has(lead.state)) ht = 20;
  else if (isHighTax) ht = 15;
  else if (stateRate?.is_target) ht = 8;
  else if (LOW_TAX_NO_PITCH.has(lead.state)) ht = 3;
  breakdown.state_arbitrage = ht;
  if (HIGH_ARBITRAGE.has(lead.state)) reasons.push(`${lead.state} → NV tax arbitrage is huge`);
  else if (isHighTax) reasons.push(`in ${lead.state} (high state tax)`);
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
  // City surcharge (NYC, Portland, etc.) is layered onto the state rate.
  const stateTotalRate = stateRate ? stateRate.ltcg_rate + stateRate.surcharge + cityBoost.rate : null;
  if (cityBoost.city) reasons.push(`${cityBoost.city} adds +${(cityBoost.rate * 100).toFixed(2)}% city tax`);
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
    city_surcharge_applied: cityBoost.city ? { city: cityBoost.city, rate: cityBoost.rate } : null,
    days_until_45_deadline: daysTo45, days_until_180_deadline: daysTo180,
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
    city_surcharge_applied: null,
    days_until_45_deadline: days != null ? 45 - days : null,
    days_until_180_deadline: days != null ? 180 - days : null,
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
    city_surcharge_applied: null,
    days_until_45_deadline: days != null ? 45 - days : null,
    days_until_180_deadline: days != null ? 180 - days : null,
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
    .select("state, ltcg_rate, surcharge, is_high_tax, is_target, priority_rank, city_surcharges")
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
    days_until_45_deadline: r.days_until_45_deadline,
    days_until_180_deadline: r.days_until_180_deadline,
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
      payload: {},
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
