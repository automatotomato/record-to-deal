// Qualifier agent: score each lead's 1031-exchange propensity, assign a tier
// (A/B/C/D), flag urgency, estimate tax exposure, and (optionally) auto-fan
// out the Profiler for high-tier leads. Pure scoring — no external API calls.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// High-tax origin states — owners here have the strongest 1031 motivation
const HIGH_TAX_STATES = new Set([
  "CA", "NY", "NJ", "OR", "MN", "HI", "MA", "CT", "VT", "MD", "IL", "DC",
]);

// Approx blended cap-gain rate by state (federal 23.8% + state, simplified)
const STATE_BLENDED_RATE: Record<string, number> = {
  CA: 0.37, NY: 0.348, NJ: 0.348, OR: 0.337, MN: 0.336, HI: 0.349,
  MA: 0.288, CT: 0.308, VT: 0.328, MD: 0.296, IL: 0.288, DC: 0.323,
  TX: 0.238, FL: 0.238, NV: 0.238, WA: 0.238,
};

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

function score(lead: Lead): ScoreResult {
  const breakdown: Record<string, number> = {};
  const notes: string[] = [];

  // 1) High-tax origin state — biggest single signal
  if (HIGH_TAX_STATES.has(lead.state)) {
    breakdown.high_tax_state = 25;
    notes.push(`${lead.state} is a high-tax origin state`);
  }

  // 2) Property type — investment assets are 1031-eligible, primary homes are not
  const investmentTypes = new Set(["Multifamily", "Commercial", "Industrial", "Mixed", "Land"]);
  if (investmentTypes.has(lead.property_type ?? "")) {
    breakdown.investment_property = 20;
  } else if (lead.property_type === "SFR") {
    breakdown.investment_property = 8;
    notes.push("SFR — only qualifies if rental, not primary residence");
  }

  // 3) Owner type — entities almost always investment-held
  const ownerType = lead.owner_type ?? "Unknown";
  if (ownerType === "LLC" || ownerType === "Corporation") {
    breakdown.entity_owner = 15;
  } else if (ownerType === "Trust" || ownerType === "Estate") {
    breakdown.entity_owner = 12;
    notes.push("Trust/Estate — possible estate-planning motivation");
  } else if (ownerType === "Individual") {
    breakdown.entity_owner = 5;
  }

  // 4) Sale price — bigger sale = bigger tax bill = more 1031 leverage
  const sp = lead.sale_price ?? 0;
  if (sp >= 5_000_000) breakdown.sale_size = 20;
  else if (sp >= 2_000_000) breakdown.sale_size = 15;
  else if (sp >= 1_000_000) breakdown.sale_size = 10;
  else if (sp >= 500_000) breakdown.sale_size = 5;

  // 5) Recency — 1031 has a 45-day identification window from closing
  const daysSinceSale = daysBetween(lead.sale_date ?? lead.deed_date);
  let isUrgent = false;
  if (daysSinceSale != null) {
    if (daysSinceSale <= 30) {
      breakdown.recent_sale = 20;
      isUrgent = true;
      notes.push(`Sold ${daysSinceSale}d ago — inside 45-day ID window`);
    } else if (daysSinceSale <= 45) {
      breakdown.recent_sale = 15;
      isUrgent = true;
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

  // Tier thresholds — must match the lead_tier enum
  let tier: "URGENT" | "HOT" | "WARM" | "COLD" | "DISQUALIFIED" = "DISQUALIFIED";
  if (total >= 70) tier = "HOT";
  else if (total >= 50) tier = "WARM";
  else if (total >= 30) tier = "COLD";
  if (isUrgent && total >= 50) tier = "URGENT";

  // Tax exposure — prefer Smarty-derived values when available (assessed value
  // gives us the current FMV, sale_price gives us the basis, ownership_years
  // tells us how much depreciation has been taken).
  const rate = STATE_BLENDED_RATE[lead.state] ?? 0.25;
  const fmv = lead.assessed_value ?? 0;
  const basis = sp ?? 0;
  let capitalGainsEstimate: number | null = null;
  let depreciationRecapture: number | null = null;

  if (fmv > 0 && basis > 0 && fmv > basis) {
    // Have both values from Smarty — compute real gain
    const gain = fmv - basis;
    capitalGainsEstimate = Math.round(gain * rate);
  } else if (basis > 0) {
    // Only have sale price — assume 60% appreciation as fallback
    capitalGainsEstimate = Math.round(basis * 0.6 * rate);
  }

  if ((held ?? 0) >= 1 && basis > 0) {
    // Straight-line depreciation taken (commercial 39y, residential 27.5y)
    const depYears = Math.min(held ?? 0, 39);
    const improvementAssumption = basis * 0.7; // assume 70% of basis is improvements
    const depTaken = (improvementAssumption / 39) * depYears;
    depreciationRecapture = Math.round(depTaken * 0.25);
  }

  const totalTaxExposure =
    (capitalGainsEstimate ?? 0) + (depreciationRecapture ?? 0) || null;

  if (totalTaxExposure && totalTaxExposure > 500_000) {
    notes.push(`Est. tax exposure ~$${Math.round(totalTaxExposure / 1000)}k`);
  }

  return {
    score: total,
    tier,
    is_urgent: isUrgent,
    capital_gains_estimate: capitalGainsEstimate,
    depreciation_recapture_est: depreciationRecapture,
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
    auto_profile?: boolean; // fan out Profiler for ALL scored leads (default true)
    profile_cap?: number; // max leads to profile in one run (default 50)
    run_id?: string;
  } = {};
  try { body = await req.json(); } catch (_) {}
  const autoProfile = body.auto_profile !== false; // default true
  const profileCap = body.profile_cap ?? 50;

  // Load target leads
  let q = supabase
    .from("leads")
    .select("id, state, county, property_type, owner_type, owner_name, sale_price, sale_date, deed_date, ownership_years, assessed_value, property_address, trigger_event");
  if (body.lead_ids?.length) {
    q = q.in("id", body.lead_ids);
  } else if (!body.rescore_all) {
    q = q.eq("tier", "UNSCORED");
  }
  const { data: leads, error } = await q.limit(500);
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const list = (leads ?? []) as Lead[];
  let qualified = 0;
  const tierUrgent: string[] = [];
  const tierHot: string[] = [];
  const tierWarm: string[] = [];
  const allScored: string[] = []; // every successfully scored lead, in order

  for (const lead of list) {
    const r = score(lead);
    const { error: upErr } = await supabase
      .from("leads")
      .update({
        score: r.score,
        tier: r.tier,
        is_urgent: r.is_urgent,
        capital_gains_estimate: r.capital_gains_estimate,
        depreciation_recapture_est: r.depreciation_recapture_est,
        total_tax_exposure: r.total_tax_exposure,
        ownership_years: r.ownership_years,
        score_breakdown: r.score_breakdown,
        qualifier_notes: r.qualifier_notes,
      })
      .eq("id", lead.id);
    if (upErr) { console.warn("Score update failed:", upErr.message); continue; }
    qualified += 1;
    if (r.tier === "URGENT") tierUrgent.push(lead.id);
    else if (r.tier === "HOT") tierHot.push(lead.id);
    else if (r.tier === "WARM") tierWarm.push(lead.id);
    allScored.push(lead.id);

    await supabase.from("lead_activities").insert({
      lead_id: lead.id,
      kind: "qualifier_scored",
      summary: `Tier ${r.tier} · score ${r.score}${r.is_urgent ? " · URGENT" : ""}`,
      payload: { breakdown: r.score_breakdown, run_id: body.run_id ?? null },
    });
  }

  // Fan out the Profiler for EVERY scored lead (urgent + hot first, then warm, then rest)
  // so seller/owner contact info is pulled automatically for every property.
  let profiled = 0;
  let profileTargetCount = 0;
  if (autoProfile) {
    const priority = [...tierUrgent, ...tierHot, ...tierWarm];
    const rest = allScored.filter((id) => !priority.includes(id));
    const targets = [...priority, ...rest].slice(0, profileCap);
    profileTargetCount = targets.length;
    const work = async () => {
      // Concurrency 3 — Firecrawl rate-limit friendly
      const queue = [...targets];
      const enriched: string[] = [];
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
      await Promise.all([worker(), worker(), worker()]);
      // Re-score enriched leads so tier/score/tax exposure reflect Smarty data
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

  // Update run row if linked
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
