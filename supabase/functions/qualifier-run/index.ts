// Qualifier agent: score each lead's 1031-exchange propensity, assign a tier
// (URGENT/HOT/WARM/COLD/DISQUALIFIED), flag urgency, estimate fed + state
// tax exposure separately, and fan out the Profiler for every scored lead.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Federal LTCG (20%) + NIIT (3.8%). State portion comes from state_tax_rates.
const FEDERAL_LTCG_RATE = 0.238;

interface StateRate {
  state: string;
  ltcg_rate: number;
  surcharge: number;
  is_high_tax: boolean;
}

interface Lead {
  id: string;
  state: string;
  county?: string | null;
  property_type?: string | null;
  owner_type?: string | null;
  owner_name?: string | null;
  sale_price?: number | null;
  sale_date?: string | null;
  deed_date?: string | null;
  ownership_years?: number | null;
  assessed_value?: number | null;
  property_address?: string | null;
  trigger_event?: string | null;
}

interface ScoreResult {
  score: number;
  tier: "URGENT" | "HOT" | "WARM" | "COLD" | "DISQUALIFIED";
  is_urgent: boolean;
  state_tax_rate: number | null;
  fed_capital_gains_estimate: number | null;
  state_capital_gains_estimate: number | null;
  capital_gains_estimate: number | null;
  depreciation_recapture_est: number | null;
  total_tax_exposure: number | null;
  ownership_years: number | null;
  score_breakdown: Record<string, number>;
  qualifier_notes: string;
}

function daysBetween(a: string | null | undefined, b = new Date()): number | null {
  if (!a) return null;
  const t = new Date(a).getTime();
  if (isNaN(t)) return null;
  return Math.floor((b.getTime() - t) / 86_400_000);
}

function score(lead: Lead, stateRate: StateRate | null): ScoreResult {
  const breakdown: Record<string, number> = {};
  const notes: string[] = [];

  const ownerType = lead.owner_type ?? "Unknown";
  const propertyType = lead.property_type ?? "Unknown";
  const sp = lead.sale_price ?? 0;
  const addr = (lead.property_address ?? "").toUpperCase();
  const isCondoOrApt = /\b(APT|UNIT|#|STE|SUITE)\b/.test(addr);
  const isHighTax = !!stateRate?.is_high_tax;

  // --- HARD DISQUALIFIERS ---
  const isLikelyHomeowner =
    (propertyType === "SFR" && ownerType === "Individual" && sp > 0 && sp < 750_000) ||
    (isCondoOrApt && ownerType === "Individual" && sp > 0 && sp < 1_000_000);
  if (isLikelyHomeowner) {
    return {
      score: 0,
      tier: "DISQUALIFIED",
      is_urgent: false,
      state_tax_rate: stateRate ? stateRate.ltcg_rate + stateRate.surcharge : null,
      fed_capital_gains_estimate: null,
      state_capital_gains_estimate: null,
      capital_gains_estimate: null,
      depreciation_recapture_est: null,
      total_tax_exposure: null,
      ownership_years: lead.ownership_years ?? null,
      score_breakdown: { homeowner_filter: 0 },
      qualifier_notes: "Auto-disqualified: owner-occupied residential under threshold",
    };
  }

  // 1) High-tax state — biggest single signal
  if (isHighTax) {
    breakdown.high_tax_state = 25;
    const stateTotalRate = (stateRate!.ltcg_rate + stateRate!.surcharge) * 100;
    notes.push(`${lead.state} state cap-gains ~${stateTotalRate.toFixed(1)}%`);
  } else if (lead.state === "NV") {
    // NV is explicitly de-prioritized: still scored but doesn't earn high-tax points
    notes.push("Nevada: no state cap-gains motivation");
  }

  // 2) Property type
  const investmentTypes = new Set(["Multifamily", "Commercial", "Industrial", "Mixed", "Land"]);
  if (investmentTypes.has(propertyType)) {
    breakdown.investment_property = 20;
  } else if (propertyType === "SFR") {
    breakdown.investment_property = 8;
    notes.push("SFR — only qualifies if rental");
  }

  // 3) Owner type
  if (ownerType === "LLC" || ownerType === "Corporation") {
    breakdown.entity_owner = 15;
  } else if (ownerType === "Trust" || ownerType === "Estate") {
    breakdown.entity_owner = 12;
    notes.push("Trust/Estate — possible estate-planning motivation");
  } else if (ownerType === "Individual") {
    breakdown.entity_owner = 5;
  }

  // 4) Sale size
  if (sp >= 5_000_000) breakdown.sale_size = 20;
  else if (sp >= 2_000_000) breakdown.sale_size = 15;
  else if (sp >= 1_000_000) breakdown.sale_size = 10;
  else if (sp >= 500_000) breakdown.sale_size = 5;

  // 5) Recency — 45-day ID window
  const daysSinceSale = daysBetween(lead.sale_date ?? lead.deed_date);
  let isInsideWindow = false;
  if (daysSinceSale != null) {
    if (daysSinceSale <= 30) {
      breakdown.recent_sale = 20;
      isInsideWindow = true;
      notes.push(`Sold ${daysSinceSale}d ago — inside 45-day ID window`);
    } else if (daysSinceSale <= 45) {
      breakdown.recent_sale = 15;
      isInsideWindow = true;
      notes.push(`Sold ${daysSinceSale}d ago — closing 45-day ID window`);
    } else if (daysSinceSale <= 180) {
      breakdown.recent_sale = 8;
    } else if (daysSinceSale <= 365) {
      breakdown.recent_sale = 3;
    }
  }

  // 6) Long hold — depreciation recapture exposure
  const held = lead.ownership_years ?? null;
  if (held != null) {
    if (held >= 20) breakdown.long_hold = 10;
    else if (held >= 10) breakdown.long_hold = 6;
    else if (held >= 5) breakdown.long_hold = 3;
  }

  // 7) Trigger event boost
  if (lead.trigger_event === "probate" || lead.trigger_event === "pending_sale") {
    breakdown.trigger_boost = 5;
  }

  const total = Object.values(breakdown).reduce((s, n) => s + n, 0);

  // --- TIER ---
  let tier: "URGENT" | "HOT" | "WARM" | "COLD" | "DISQUALIFIED" = "DISQUALIFIED";
  if (total >= 70) tier = "HOT";
  else if (total >= 50) tier = "WARM";
  else if (total >= 30) tier = "COLD";

  // --- URGENT (new rule) ---
  // PRIMARY: high-tax state + 30-day window + investor signal
  // SECONDARY: NV recent sale w/ investor signal (lower confidence)
  const investorSignal =
    ownerType === "LLC" || ownerType === "Corporation" || ownerType === "Trust" ||
    investmentTypes.has(propertyType) ||
    sp >= 1_000_000;

  let isUrgent = false;
  if (isInsideWindow && investorSignal) {
    if (isHighTax) {
      tier = "URGENT";
      isUrgent = true;
      notes.push("URGENT: high-tax state + inside ID window");
    } else if (lead.state === "NV" && total >= 50) {
      tier = "URGENT";
      isUrgent = true;
      notes.push("URGENT (secondary): NV recent investor sale");
    }
  }

  // --- TAX MATH (separated) ---
  const stateRateTotal = stateRate ? stateRate.ltcg_rate + stateRate.surcharge : null;
  const fmv = lead.assessed_value ?? 0;
  const basis = sp ?? 0;
  let gain = 0;
  if (fmv > 0 && basis > 0 && fmv > basis) {
    gain = fmv - basis;
  } else if (basis > 0) {
    gain = basis * 0.6; // fallback: assume 60% appreciation
  }

  const fedCapGains = gain > 0 ? Math.round(gain * FEDERAL_LTCG_RATE) : null;
  const stateCapGains = gain > 0 && stateRateTotal != null
    ? Math.round(gain * stateRateTotal)
    : null;

  let recapture: number | null = null;
  if ((held ?? 0) >= 1 && basis > 0) {
    const depYears = Math.min(held ?? 0, 39);
    const improvementAssumption = basis * 0.7;
    const depTaken = (improvementAssumption / 39) * depYears;
    recapture = Math.round(depTaken * 0.25);
  }

  const totalTaxExposure =
    (fedCapGains ?? 0) + (stateCapGains ?? 0) + (recapture ?? 0) || null;

  if (totalTaxExposure && totalTaxExposure > 500_000) {
    notes.push(`Est. tax exposure ~$${Math.round(totalTaxExposure / 1000)}k`);
  }

  return {
    score: total,
    tier,
    is_urgent: isUrgent,
    state_tax_rate: stateRateTotal,
    fed_capital_gains_estimate: fedCapGains,
    state_capital_gains_estimate: stateCapGains,
    // Keep legacy field populated for backward compat (fed + state combined)
    capital_gains_estimate: (fedCapGains ?? 0) + (stateCapGains ?? 0) || null,
    depreciation_recapture_est: recapture,
    total_tax_exposure: totalTaxExposure,
    ownership_years: held,
    score_breakdown: breakdown,
    qualifier_notes: notes.join(" · "),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  let body: {
    lead_ids?: string[];
    rescore_all?: boolean;
    auto_profile?: boolean;
    profile_cap?: number;
    run_id?: string;
  } = {};
  try { body = await req.json(); } catch (_) {}
  const autoProfile = body.auto_profile !== false; // default true
  const profileCap = body.profile_cap ?? 200;

  // Load state tax rate cheat sheet once
  const { data: rateRows } = await supabase
    .from("state_tax_rates")
    .select("state, ltcg_rate, surcharge, is_high_tax");
  const rateMap = new Map<string, StateRate>(
    (rateRows ?? []).map((r: any) => [r.state, r as StateRate]),
  );

  // Page through leads in 500-row batches until done (no hard cap).
  const PAGE = 500;
  let qualified = 0;
  const tierUrgent: string[] = [];
  const tierHot: string[] = [];
  const tierWarm: string[] = [];
  const allScored: string[] = [];

  let page = 0;
  while (true) {
    let q = supabase
      .from("leads")
      .select("id, state, county, property_type, owner_type, owner_name, sale_price, sale_date, deed_date, ownership_years, assessed_value, property_address, trigger_event")
      .order("created_at", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (body.lead_ids?.length) {
      q = q.in("id", body.lead_ids);
    } else if (!body.rescore_all) {
      q = q.eq("tier", "UNSCORED");
    }
    const { data: leads, error } = await q;
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const list = (leads ?? []) as Lead[];
    if (!list.length) break;

    for (const lead of list) {
      const stateRate = rateMap.get(lead.state) ?? null;
      const r = score(lead, stateRate);
      const newStage = r.tier === "DISQUALIFIED" ? "scored" : "scored";
      const { error: upErr } = await supabase
        .from("leads")
        .update({
          score: r.score,
          tier: r.tier,
          is_urgent: r.is_urgent,
          state_tax_rate: r.state_tax_rate,
          fed_capital_gains_estimate: r.fed_capital_gains_estimate,
          state_capital_gains_estimate: r.state_capital_gains_estimate,
          capital_gains_estimate: r.capital_gains_estimate,
          depreciation_recapture_est: r.depreciation_recapture_est,
          total_tax_exposure: r.total_tax_exposure,
          ownership_years: r.ownership_years,
          score_breakdown: r.score_breakdown,
          qualifier_notes: r.qualifier_notes,
          pipeline_stage: newStage,
        })
        .eq("id", lead.id);
      if (upErr) { console.warn("Score update failed:", upErr.message); continue; }
      qualified += 1;
      if (r.tier === "URGENT") tierUrgent.push(lead.id);
      else if (r.tier === "HOT") tierHot.push(lead.id);
      else if (r.tier === "WARM") tierWarm.push(lead.id);
      if (r.tier !== "DISQUALIFIED") allScored.push(lead.id);

      await supabase.from("lead_activities").insert({
        lead_id: lead.id,
        kind: "qualifier_scored",
        summary: `Tier ${r.tier} · score ${r.score}${r.is_urgent ? " · URGENT" : ""}`,
        payload: { breakdown: r.score_breakdown, run_id: body.run_id ?? null },
      });
    }

    if (list.length < PAGE) break;
    page += 1;
    if (body.lead_ids?.length || body.rescore_all) break; // these are explicit batches
  }

  // Fan out the Profiler for every scored lead — urgent/hot first
  let profiled = 0;
  let profileTargetCount = 0;
  if (autoProfile) {
    const priority = [...tierUrgent, ...tierHot, ...tierWarm];
    const rest = allScored.filter((id) => !priority.includes(id));
    const targets = [...priority, ...rest].slice(0, profileCap);
    profileTargetCount = targets.length;
    const work = async () => {
      const queue = [...targets];
      const enriched: string[] = [];
      // Concurrency 5 (was 3) — Firecrawl rate-limit still friendly
      const worker = async () => {
        while (queue.length) {
          const id = queue.shift();
          if (!id) break;
          try {
            await supabase.functions.invoke("profiler-run", { body: { lead_id: id, force: true } });
            enriched.push(id);
            profiled += 1;
          } catch (e) {
            console.warn("Profiler failed for", id, e);
          }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker(), worker()]);
      // Re-score enriched leads so tier/exposure reflect freshly-fetched data
      if (enriched.length) {
        try {
          await supabase.functions.invoke("qualifier-run", {
            body: { lead_ids: enriched, auto_profile: false },
          });
        } catch (e) {
          console.warn("Re-qualify after profiling failed:", e);
        }
      }
      if (body.run_id) {
        await supabase
          .from("scout_runs")
          .update({ leads_profiled: profiled })
          .eq("id", body.run_id);
      }
    };
    // @ts-ignore
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(work());
    } else {
      work().catch((e) => console.error(e));
    }
  }

  if (body.run_id) {
    await supabase
      .from("scout_runs")
      .update({ leads_qualified: qualified })
      .eq("id", body.run_id);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      qualified,
      tier_urgent: tierUrgent.length,
      tier_hot: tierHot.length,
      tier_warm: tierWarm.length,
      auto_profiling: profileTargetCount,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
