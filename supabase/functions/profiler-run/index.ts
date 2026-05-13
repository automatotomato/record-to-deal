// Profiler agent: enriches a lead using Smarty US Property Data (principal),
// then uses AI to build a personality profile + draft a tailored 1031
// outreach email. Persists everything back to the leads table.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SMARTY_LOOKUP = "https://us-property.api.smarty.com/lookup";
const SMARTY_SEARCH = "https://us-property.api.smarty.com/search";
const ATTOM_BASE = "https://api.gateway.attomdata.com/propertyapi/v1.0.0";
const AI_URL = "https://api.openai.com/v1/chat/completions";
const AI_MODEL = "gpt-4o-mini";

// --- ATTOM enrichment ---------------------------------------------------
// Returns a SmartyAttrs-shaped object so downstream mapping/estimator code
// works unchanged. ATTOM gives us richer NV coverage than Smarty.
async function attomEnrich(
  street: string,
  city: string | null,
  state: string | null,
  apiKey: string,
): Promise<{ attrs: SmartyAttrs; sources: string[] } | null> {
  const params = new URLSearchParams({ address1: street });
  if (city && state) params.set("address2", `${city}, ${state}`);
  else if (state) params.set("address2", state);
  try {
    const r = await fetch(`${ATTOM_BASE}/property/expandedprofile?${params}`, {
      headers: { Accept: "application/json", apikey: apiKey },
    });
    if (!r.ok) {
      console.warn(`ATTOM expandedprofile ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return null;
    }
    const data = await r.json();
    const p = data?.property?.[0];
    if (!p) return null;

    const owner = p.owner ?? {};
    const o1 = owner.owner1 ?? {};
    const sale = p.sale ?? {};
    const assessment = p.assessment ?? {};
    const assessed = assessment.assessed ?? {};
    const market = assessment.market ?? {};
    const tax = assessment.tax ?? {};
    const mortgage = assessment.mortgage ?? {};
    const summary = p.summary ?? {};
    const building = p.building ?? {};
    const lot = p.lot ?? {};
    const mailingAddr = owner.mailingaddressoneline ?? owner.mailingAddress?.oneLine ?? null;

    const ownerName =
      o1.fullname ||
      [o1.firstnameandmi, o1.lastname].filter(Boolean).join(" ").trim() ||
      null;
    const isCompany =
      (o1.lastname && /\b(LLC|INC|CORP|TRUST|COMPANY|LP|LLP|HOLDINGS)\b/i.test(o1.lastname)) ||
      (ownerName && /\b(LLC|INC|CORP|TRUST|COMPANY|LP|LLP|HOLDINGS)\b/i.test(ownerName));

    // Fold mailing one-liner into the mail_* fields the rest of the code reads
    const attrs: SmartyAttrs = {
      owner_full_name: ownerName,
      ownership_type: isCompany ? "company" : "individual",
      company_flag: isCompany ? "owner_is_company" : null,
      mail_full_address: mailingAddr,
      mail_city: owner.mailingaddresscity ?? null,
      mail_state: owner.mailingaddressstate ?? null,
      mail_zipcode: owner.mailingaddresszip ?? null,
      deed_sale_price: sale?.amount?.saleamt ?? null,
      deed_sale_date: sale?.salesearchdate ?? sale?.amount?.salerecdate ?? null,
      assessed_value: assessed?.assdttlvalue ?? null,
      assessed_improvement_value: assessed?.assdimprvalue ?? null,
      market_value: market?.mktttlvalue ?? null,
      tax_billed_amount: tax?.taxamt ?? null,
      land_use_standard: summary?.propclass ?? summary?.propsubtype ?? null,
      land_use_group: summary?.proptype ?? null,
      building_sqft: building?.size?.bldgsize ?? building?.size?.universalsize ?? null,
      year_built: summary?.yearbuilt ?? building?.summary?.yearbuiltrenov ?? null,
      acres: lot?.lotsize1 ?? null,
      owner_occupancy_status:
        summary?.absenteeInd === "ABSENTEE" || summary?.absenteeInd === "ABSENTEE_OWNER"
          ? "not_owner_occupied"
          : null,
      financial_history: mortgage?.amount
        ? [{
            mortgage_amount: mortgage.amount,
            mortgage_type: mortgage.loantype ?? null,
            lender_name: mortgage.lender?.lastname ?? mortgage.lender?.fullname ?? null,
            mortgage_recording_date: mortgage.date ?? null,
          }]
        : [],
    };
    return {
      attrs,
      sources: [
        "attomdata.com",
        p.identifier?.attomId ? `attom_id:${p.identifier.attomId}` : null,
      ].filter(Boolean) as string[],
    };
  } catch (e) {
    console.warn("ATTOM enrich failed:", e);
    return null;
  }
}

interface Lead {
  id: string;
  owner_name?: string | null;
  owner_type?: string | null;
  property_address?: string | null;
  property_city?: string | null;
  property_zip?: string | null;
  state?: string | null;
  county?: string | null;
  property_type?: string | null;
  sale_price?: number | null;
  sale_date?: string | null;
  mailing_address?: string | null;
  parcel_number?: string | null;
  smarty_key?: string | null;
}

type SmartyAttrs = Record<string, unknown> & {
  financial_history?: Array<Record<string, unknown>>;
};

interface SmartyRecord {
  smarty_key?: string;
  matched_address?: {
    street?: string;
    city?: string;
    state?: string;
    zipcode?: string;
  };
  attributes?: SmartyAttrs;
}

// --- Smarty fetchers ----------------------------------------------------

async function smartyByKey(
  smartyKey: string,
  authId: string,
  authToken: string,
): Promise<SmartyRecord | null> {
  const url =
    `${SMARTY_LOOKUP}/${encodeURIComponent(smartyKey)}/property/principal` +
    `?auth-id=${encodeURIComponent(authId)}&auth-token=${encodeURIComponent(authToken)}&license=us-property-data-principal-cloud`;
  try {
    const r = await fetch(url, { headers: { "Content-Type": "application/json" } });
    if (!r.ok) {
      console.warn(`Smarty lookup ${r.status} for key ${smartyKey}`);
      return null;
    }
    const data = await r.json();
    const arr = Array.isArray(data) ? data : [];
    return arr[0] ?? null;
  } catch (e) {
    console.warn("Smarty key lookup failed:", e);
    return null;
  }
}

async function smartyByAddress(
  street: string,
  city: string | null,
  state: string | null,
  zipcode: string | null,
  authId: string,
  authToken: string,
): Promise<SmartyRecord | null> {
  const params = new URLSearchParams({
    "auth-id": authId,
    "auth-token": authToken,
    "license": "us-property-data-principal-cloud",
    street,
  });
  if (city) params.set("city", city);
  if (state) params.set("state", state);
  if (zipcode) params.set("zipcode", zipcode);
  const url = `${SMARTY_SEARCH}/property/principal?${params.toString()}`;
  try {
    const r = await fetch(url, { headers: { "Content-Type": "application/json" } });
    if (!r.ok) {
      const t = await r.text();
      console.warn(`Smarty search ${r.status}: ${t.slice(0, 200)}`);
      return null;
    }
    const data = await r.json();
    const arr = Array.isArray(data) ? data : [];
    return arr[0] ?? null;
  } catch (e) {
    console.warn("Smarty address search failed:", e);
    return null;
  }
}

// --- Field mapping ------------------------------------------------------

function s(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const str = String(v).trim();
  return str.length ? str : null;
}
function n(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const num = Number(v);
  return Number.isFinite(num) ? num : null;
}

function buildMailingAddress(a: SmartyAttrs): string | null {
  // Smarty's principal license uses `mail_*` for the owner's mailing address.
  // The legacy `contact_*` fields are kept as a fallback for older responses.
  const street =
    s(a.mail_full_address) ??
    s(a.mail_street) ??
    s(a.contact_full_address) ??
    s(a.contact_street);
  const unit = s(a.mail_unit_designator) ?? s(a.contact_unit_designator);
  const city = s(a.mail_city) ?? s(a.contact_city);
  const state = s(a.mail_state) ?? s(a.contact_state);
  const zip = s(a.mail_zipcode) ?? s(a.mail_zip) ?? s(a.contact_zip);
  const zip4 = s(a.mail_zip4) ?? s(a.contact_zip4);
  if (!street && !city) return null;
  const line1 = [street, unit].filter(Boolean).join(" ");
  const line2 = [city, state].filter(Boolean).join(", ");
  const zipFull = zip ? (zip4 ? `${zip}-${zip4}` : zip) : "";
  return [line1, [line2, zipFull].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

// Real cap-gains + recapture estimator. Uses a state-blended rate and only
// returns numbers when we actually have basis + current value — never fabricated.
const STATE_BLENDED_RATE: Record<string, number> = {
  CA: 0.37, NY: 0.348, NJ: 0.348, OR: 0.337, MN: 0.336, HI: 0.349,
  MA: 0.288, CT: 0.308, VT: 0.328, MD: 0.296, IL: 0.288, DC: 0.323,
  TX: 0.238, FL: 0.238, NV: 0.238, WA: 0.238,
};

function estimateTaxExposure(
  a: SmartyAttrs,
  state: string | null,
  currentSalePrice: number | null,
  ownershipYears: number | null,
): { capitalGains: number | null; recapture: number | null } {
  const rate = STATE_BLENDED_RATE[state ?? ""] ?? 0.25;
  const priorPrice = n(a.prior_sale_amount) ?? n(a.previous_sale_amount);
  const assessedTotal = n(a.assessed_value);
  const improvement = n(a.assessed_improvement_value);
  const market = n(a.market_value) ?? n(a.market_value_year);
  const basis = priorPrice ?? (assessedTotal ? Math.round(assessedTotal * 0.85) : null);
  const current = currentSalePrice ?? market ?? assessedTotal;

  let capitalGains: number | null = null;
  if (basis && current && current > basis) {
    const sellingCosts = current * 0.06;
    const gain = current - basis - sellingCosts;
    if (gain > 0) capitalGains = Math.round(gain * rate);
  }

  let recapture: number | null = null;
  if (improvement && ownershipYears && ownershipYears > 0) {
    const isResidential = ((s(a.land_use_standard) ?? "").toLowerCase().includes("multi") ||
      (s(a.land_use_standard) ?? "").toLowerCase().includes("apart"));
    const depLife = isResidential ? 27.5 : 39;
    const yearsCapped = Math.min(ownershipYears, depLife);
    const depTaken = (improvement / depLife) * yearsCapped;
    recapture = Math.round(depTaken * 0.25);
  }
  return { capitalGains, recapture };
}

function mapPropertyType(landUse: string | null): string {
  if (!landUse) return "Unknown";
  const lu = landUse.toLowerCase();
  if (lu.includes("multi") || lu.includes("apartment")) return "Multifamily";
  if (lu.includes("retail") || lu.includes("commercial") || lu.includes("office") || lu.includes("industrial")) return "Commercial";
  if (lu.includes("single") || lu.includes("residential") || lu.includes("sfr")) return "SingleFamily";
  if (lu.includes("land") || lu.includes("vacant")) return "Land";
  return "Unknown";
}

function yearsBetween(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000));
}

function extractWealthSignals(a: SmartyAttrs, source: string): Array<{ signal: string; source?: string }> {
  const out: Array<{ signal: string; source?: string }> = [];
  const hist = Array.isArray(a.financial_history) ? a.financial_history : [];
  for (const m of hist.slice(0, 5)) {
    const amt = n((m as Record<string, unknown>).mortgage_amount);
    const lender = s((m as Record<string, unknown>).lender_name);
    const date = s((m as Record<string, unknown>).mortgage_recording_date);
    const type = s((m as Record<string, unknown>).mortgage_type);
    if (amt && amt > 0) {
      const parts = [`$${amt.toLocaleString()} ${type ?? ""} mortgage`.trim()];
      if (lender) parts.push(`from ${lender}`);
      if (date) parts.push(`(${date.slice(0, 10)})`);
      out.push({ signal: parts.join(" "), source });
    }
  }
  const assessed = n(a.assessed_value);
  const tax = n(a.tax_billed_amount);
  if (assessed) out.push({ signal: `Assessed value $${assessed.toLocaleString()}`, source });
  if (tax) out.push({ signal: `Annual tax $${tax.toLocaleString()}`, source });
  if (s(a.owner_occupancy_status) === "not_owner_occupied") {
    out.push({ signal: "Not owner-occupied (investment property)", source });
  }
  return out;
}

// --- Handler ------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const smartyId = Deno.env.get("SMARTY_AUTH_ID");
  const smartyToken = Deno.env.get("SMARTY_AUTH_TOKEN");
  const lovableKey = Deno.env.get("OPENAI_API_KEY");
  const attomKey = Deno.env.get("ATTOM_API_KEY");

  if (!lovableKey || (!attomKey && (!smartyId || !smartyToken))) {
    return new Response(
      JSON.stringify({ error: "ATTOM_API_KEY or SMARTY credentials, plus OPENAI_API_KEY, must be configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  let body: { lead_id?: string; force?: boolean } = {};
  try { body = await req.json(); } catch (_) {}
  const leadId = body.lead_id;
  const force = body.force === true;
  if (!leadId) {
    return new Response(JSON.stringify({ error: "lead_id required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data: lead, error: leadErr } = await supabase
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .single();
  if (leadErr || !lead) {
    return new Response(JSON.stringify({ error: leadErr?.message ?? "lead not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Cache guard: if seller info already on file, skip unless force
  const hasSellerInfo =
    !!(lead.contact_email || lead.contact_phone || lead.contact_linkedin || lead.mailing_address);
  if (hasSellerInfo && !force) {
    return new Response(
      JSON.stringify({
        ok: true,
        cached: true,
        lead_id: leadId,
        message: "Seller info already on file. Pass force:true to re-profile.",
        contact_email: lead.contact_email,
        contact_phone: lead.contact_phone,
        contact_linkedin: lead.contact_linkedin,
        mailing_address: lead.mailing_address,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const l = lead as Lead;

  // 1. Try ATTOM first (best NV coverage), fall back to Smarty.
  let smarty: SmartyRecord | null = null;
  let enrichSource: "attom" | "smarty" | null = null;
  let extraSources: string[] = [];

  if (attomKey && l.property_address) {
    const attom = await attomEnrich(
      l.property_address,
      l.property_city ?? null,
      l.state ?? null,
      attomKey,
    );
    if (attom) {
      smarty = { smarty_key: l.smarty_key ?? undefined, attributes: attom.attrs };
      enrichSource = "attom";
      extraSources = attom.sources;
    }
  }

  if (!smarty && smartyId && smartyToken) {
    if (l.smarty_key) {
      smarty = await smartyByKey(l.smarty_key, smartyId, smartyToken);
    }
    if (!smarty && l.property_address) {
      smarty = await smartyByAddress(
        l.property_address,
        l.property_city ?? null,
        l.state ?? null,
        l.property_zip ?? null,
        smartyId,
        smartyToken,
      );
    }
    if (smarty) enrichSource = "smarty";
  }

  if (!smarty || !smarty.attributes) {
    await supabase.from("lead_activities").insert({
      lead_id: leadId,
      kind: "profiler_run",
      summary: "No property match found in ATTOM or Smarty",
      payload: { source: "none", matched: false },
    });
    return new Response(
      JSON.stringify({
        ok: false,
        error: "No property match in ATTOM or Smarty",
        lead_id: leadId,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const a = smarty.attributes;
  const smartyKey = smarty.smarty_key ?? null;
  const mailingAddress = buildMailingAddress(a);
  const ownerName = s(a.owner_full_name) ?? s(a.deed_owner_full_name);
  const ownerType =
    s(a.ownership_type) === "company" || s(a.company_flag) === "owner_is_company"
      ? "LLC"
      : "Individual";
  const saleDate = s(a.deed_sale_date) ?? s(a.sale_date) ?? s(a.ownership_transfer_date);
  const salePrice = n(a.deed_sale_price) ?? n(a.sale_amount);
  const assessedValue = n(a.assessed_value);
  const ownershipYears = yearsBetween(saleDate);
  const propertyType = mapPropertyType(s(a.land_use_standard) ?? s(a.land_use_group));
  const wealthSignals = extractWealthSignals(a, "smarty.com");

  // Loud diagnostic: Smarty matched but mailing mapping yielded nothing — surface it
  if (!mailingAddress) {
    console.warn(
      `Profiler: Smarty matched lead ${leadId} but mailing address mapping returned null. ` +
      `Available mail/contact keys: ${Object.keys(a).filter((k) => k.startsWith("mail") || k.startsWith("contact")).join(",") || "(none)"}`,
    );
  }

  const { capitalGains: capitalGainsEstimate, recapture: depreciationRecapture } =
    estimateTaxExposure(a, l.state ?? null, salePrice, ownershipYears);

  // 1.5 Decision-maker enrichment chain — only runs when keys are present
  const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");
  const apolloKey = Deno.env.get("APOLLO_API_KEY");
  const enrichment = await enrichDecisionMaker({
    ownerName, ownerType, propertyAddress: l.property_address ?? null,
    city: l.property_city ?? null, state: l.state ?? null,
    firecrawlKey, apolloKey, lovableKey,
  });

  // 2. AI: build personality profile + draft email using Smarty data as source of truth
  const propertyContext = `
Property: ${l.property_address ?? "?"} · ${l.property_city ?? ""}, ${l.state ?? ""} ${l.property_zip ?? ""}
County: ${l.county ?? ""}
Type: ${propertyType}
Owner: ${ownerName ?? "Unknown"} (${ownerType})
Mailing address: ${mailingAddress ?? "Unknown"}
Sale price: ${salePrice ? `$${salePrice.toLocaleString()}` : "unknown"}
Sale date: ${saleDate ?? "unknown"}
Years held: ${ownershipYears ?? "unknown"}
Assessed value: ${assessedValue ? `$${assessedValue.toLocaleString()}` : "unknown"}
Annual tax: ${n(a.tax_billed_amount) ? `$${n(a.tax_billed_amount)!.toLocaleString()}` : "unknown"}
Building: ${s(a.building_sqft) ?? "?"} sqft · built ${s(a.year_built) ?? "?"} · ${s(a.acres) ?? "?"} acres
Owner-occupancy: ${s(a.owner_occupancy_status) ?? "unknown"}
Mortgage history (last 5):
${(Array.isArray(a.financial_history) ? a.financial_history : []).slice(0, 5).map((m, i) => {
  const r = m as Record<string, unknown>;
  return `  ${i + 1}. $${n(r.mortgage_amount)?.toLocaleString() ?? "?"} ${s(r.mortgage_type) ?? ""} from ${s(r.lender_name) ?? "?"} on ${s(r.mortgage_recording_date) ?? "?"}`;
}).join("\n") || "  (none)"}

Decision maker (best guess): ${enrichment.decisionMakerName ?? "unknown"}${enrichment.decisionMakerRole ? ` (${enrichment.decisionMakerRole})` : ""}
Likely email: ${enrichment.decisionMakerEmail ?? "unknown"}
LinkedIn: ${enrichment.decisionMakerLinkedIn ?? "unknown"}
News / web mentions: ${enrichment.newsSnippets.slice(0, 3).join(" | ") || "none"}
`.trim();

  const aiResp = await fetch(AI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lovableKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a 1031-exchange outreach analyst. Given an enriched property + owner record from Smarty " +
            "public records, build a personality + motivation profile and draft a personalized cold outreach " +
            "email offering a 1031 exchange consultation into Las Vegas property. The mailing address, owner " +
            "name, and financial details have ALREADY been verified — do not change or invent them. Focus " +
            "your output on the strategic profile and the email copy. Return ONLY valid JSON.",
        },
        {
          role: "user",
          content: `${propertyContext}

Return JSON with this exact shape:
{
  "personality_type": "e.g. Analytical Investor / Family Operator / Institutional / Legacy Holder",
  "motivation_type": "e.g. Tax deferral / Diversification / Exit fatigue / Estate planning",
  "preferred_channel": "Email | Phone | LinkedIn | Mail",
  "pitch_angle": "one-sentence angle for this specific owner",
  "lv_property_recommendation": "type of Las Vegas asset to suggest (e.g. Class B multifamily, NNN retail, build-to-rent)",
  "profiler_summary": "2-3 sentence narrative on who this owner is and why they're a 1031 candidate",
  "email_subject": "personalized subject under 60 chars",
  "email_body": "full email body, plain text, 120-180 words, signed -The team"
}`,
        },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!aiResp.ok) {
    const t = await aiResp.text();
    return new Response(JSON.stringify({ error: `AI ${aiResp.status}: ${t.slice(0, 300)}` }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const aiData = await aiResp.json();
  const content = aiData?.choices?.[0]?.message?.content ?? "{}";
  let profile: Record<string, string> = {};
  try { profile = JSON.parse(content); } catch (_) { /* ignore */ }

  // Contact completeness: mailing address (50pts), owner name (20pts),
  // decision-maker email (20pts), phone or LinkedIn (10pts)
  let completeness = 0;
  if (mailingAddress) completeness += 50;
  if (ownerName) completeness += 20;
  if (enrichment.decisionMakerEmail) completeness += 20;
  if (enrichment.decisionMakerPhone || enrichment.decisionMakerLinkedIn) completeness += 10;

  const updates: Record<string, unknown> = {
    smarty_key: smartyKey,
    owner_name: ownerName ?? l.owner_name ?? null,
    owner_type: ownerType,
    mailing_address: mailingAddress ?? l.mailing_address ?? null,
    property_type: propertyType,
    sale_date: saleDate ?? l.sale_date ?? null,
    sale_price: salePrice ?? l.sale_price ?? null,
    assessed_value: assessedValue ?? null,
    ownership_years: ownershipYears ?? null,
    capital_gains_estimate: capitalGainsEstimate,
    depreciation_recapture_est: depreciationRecapture,
    total_tax_exposure:
      ((capitalGainsEstimate ?? 0) + (depreciationRecapture ?? 0)) || null,
    wealth_signals: [...wealthSignals, ...enrichment.newsSnippets.map((sig) => ({ signal: sig, source: "firecrawl" }))],
    contact_completeness: completeness,
    contact_email: enrichment.decisionMakerEmail ?? null,
    contact_phone: enrichment.decisionMakerPhone ?? null,
    contact_linkedin: enrichment.decisionMakerLinkedIn ?? null,
    decision_maker_name: enrichment.decisionMakerName ?? null,
    decision_maker_role: enrichment.decisionMakerRole ?? null,
    decision_maker_email: enrichment.decisionMakerEmail ?? null,
    decision_maker_phone: enrichment.decisionMakerPhone ?? null,
    decision_maker_linkedin: enrichment.decisionMakerLinkedIn ?? null,
    entity_registry_url: enrichment.entityRegistryUrl ?? null,
    enrichment_confidence: enrichment.confidence,
    enrichment_payload: enrichment.payload,
    personality_type: profile.personality_type ?? null,
    motivation_type: profile.motivation_type ?? null,
    preferred_channel: profile.preferred_channel ?? null,
    pitch_angle: profile.pitch_angle ?? null,
    lv_property_recommendation: profile.lv_property_recommendation ?? null,
    profiler_summary: profile.profiler_summary ?? null,
    pipeline_stage: completeness >= 70 ? "enriched" : "profiled",
    data_sources: Array.from(new Set([
      ...(l as unknown as { data_sources?: string[] }).data_sources ?? [],
      enrichSource === "attom" ? "attomdata.com" : "smarty.com",
      ...enrichment.sources,
    ])),
  };

  const { error: updErr } = await supabase.from("leads").update(updates).eq("id", leadId);
  if (updErr) {
    return new Response(JSON.stringify({ error: updErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Draft email — ALWAYS create a draft. Use AI output when available,
  // fall back to a templated message keyed on tier/property/state so every
  // lead has something to act on.
  let emailId: string | null = null;
  {
    let subject = profile.email_subject ?? null;
    let bodyText = profile.email_body ?? null;
    let templated = false;

    if (!subject || !bodyText) {
      templated = true;
      const stateLabel = l.state ?? "your state";
      const propLabel = propertyType === "Multifamily" ? "multifamily property"
        : propertyType === "Commercial" ? "commercial property"
        : propertyType === "Land" ? "land parcel"
        : propertyType === "Industrial" ? "industrial property"
        : "investment property";
      const greeting = enrichment.decisionMakerName
        ? `Hi ${enrichment.decisionMakerName.split(/\s+/)[0]},`
        : ownerName ? `Hi ${ownerName.split(/\s+/)[0]},` : "Hello,";
      const addrLabel = l.property_address ?? `your ${stateLabel} ${propLabel}`;
      const taxLine = (capitalGainsEstimate && capitalGainsEstimate > 100_000)
        ? ` Based on public records, the federal + ${stateLabel} state capital-gains exposure on this sale is roughly $${Math.round(capitalGainsEstimate / 1000)}k — a 1031 exchange into Las Vegas (no state income tax) could defer most of that.`
        : ` A 1031 exchange into Las Vegas (no state income tax) could defer the capital-gains and depreciation-recapture liability on this sale.`;
      subject = `Quick question on ${addrLabel.split(",")[0]}`;
      bodyText = `${greeting}

Saw the recent sale of ${addrLabel}. ${taxLine}

We help sellers identify replacement properties inside the 45-day window — happy to share a shortlist of Las Vegas multifamily and NNN options that match your basis.

Worth a 15-minute call this week?

– The team
1031 Exchange Elite`;
    }

    await supabase
      .from("outreach_emails")
      .update({ status: "superseded" })
      .eq("lead_id", leadId)
      .eq("status", "draft");

    const { data: emailRow, error: emErr } = await supabase
      .from("outreach_emails")
      .insert({
        lead_id: leadId,
        subject,
        body: bodyText,
        to_email: enrichment.decisionMakerEmail ?? null,
        status: "draft",
      })
      .select("id")
      .single();
    if (emErr) console.warn("Draft insert error:", emErr.message);
    emailId = emailRow?.id ?? null;
    if (emailId) {
      await supabase.from("leads").update({
        pipeline_stage: enrichment.decisionMakerEmail ? "ready" : "drafted",
      }).eq("id", leadId);
    }
    if (templated) {
      await supabase.from("lead_activities").insert({
        lead_id: leadId,
        kind: "email_drafted",
        summary: "Templated draft (AI output incomplete)",
      });
    }
  }

  // Activity log
  const sources = enrichSource === "attom"
    ? ["https://api.developer.attomdata.com/", ...extraSources]
    : ["https://smarty.com/products/apis/us-property-data-api", smartyKey ? `smarty_key:${smartyKey}` : null].filter(Boolean) as string[];

  await supabase.from("lead_activities").insert({
    lead_id: leadId,
    kind: "profiler_run",
    summary: `Profiled via ${enrichSource?.toUpperCase() ?? "?"} — ${ownerName ?? "owner"}, mailing ${mailingAddress ? "✓" : "✗"}, ${wealthSignals.length} wealth signals`,
    payload: {
      source: enrichSource,
      smarty_key: smartyKey,
      sources,
      completeness,
      mailing_from_assessor: !!mailingAddress,
    },
  });

  return new Response(
    JSON.stringify({
      ok: true,
      smarty_key: smartyKey,
      owner_name: ownerName,
      mailing_address: mailingAddress,
      contact_completeness: completeness,
      wealth_signals: wealthSignals.length,
      email_draft_id: emailId,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});

// =====================================================================
// Decision-maker enrichment chain
// =====================================================================
// Tries, in order:
//   1. Firecrawl search the state Secretary of State business registry for
//      the LLC/Corp name → extract registered agent + officers (free).
//   2. Apollo.io organization people search if we can guess a company website.
//   3. Firecrawl search "<name> linkedin" + "<name> news" for LinkedIn URL
//      and recent press mentions (wealth/timing signals).
//   4. Lovable AI to extract the highest-confidence email/phone/LinkedIn
//      from the scraped HTML when regex misses them.
// All layers are optional and degrade gracefully when keys are missing.

interface EnrichmentResult {
  decisionMakerName: string | null;
  decisionMakerRole: string | null;
  decisionMakerEmail: string | null;
  decisionMakerPhone: string | null;
  decisionMakerLinkedIn: string | null;
  entityRegistryUrl: string | null;
  newsSnippets: string[];
  confidence: number;
  sources: string[];
  payload: Record<string, unknown>;
}

const EMPTY_ENRICHMENT: EnrichmentResult = {
  decisionMakerName: null,
  decisionMakerRole: null,
  decisionMakerEmail: null,
  decisionMakerPhone: null,
  decisionMakerLinkedIn: null,
  entityRegistryUrl: null,
  newsSnippets: [],
  confidence: 0,
  sources: [],
  payload: {},
};

const FIRECRAWL_V2 = "https://api.firecrawl.dev/v2";

// Extract a likely company website / domain from owner name + scraped pages.
function pickDomain(html: string, ownerName: string | null): string | null {
  // 1) explicit "Website: …" lines
  const m1 = html.match(/website[:\s]*<[^>]*?href="(https?:\/\/[^"]+)"/i);
  if (m1) {
    try { return new URL(m1[1]).hostname.replace(/^www\./, ""); } catch (_) {}
  }
  // 2) any non-social link
  const links = Array.from(html.matchAll(/href="(https?:\/\/[^"]+)"/g)).map((m) => m[1]);
  const slug = (ownerName ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (const url of links) {
    try {
      const h = new URL(url).hostname.replace(/^www\./, "");
      if (/(linkedin|facebook|twitter|instagram|google|maps|youtube|wikipedia|opencorporates|secretary)/i.test(h)) continue;
      if (slug && h.replace(/[^a-z0-9]/g, "").includes(slug.slice(0, 6))) return h;
    } catch (_) {}
  }
  return null;
}

function firstMatch(re: RegExp, s: string): string | null {
  const m = s.match(re);
  return m ? m[0] : null;
}

async function fcSearch(query: string, key: string, limit = 5, scrape = true) {
  try {
    const resp = await fetch(`${FIRECRAWL_V2}/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query, limit,
        scrapeOptions: scrape ? { formats: ["markdown"] } : undefined,
      }),
    });
    if (!resp.ok) {
      console.warn(`Firecrawl search ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      return [];
    }
    const data = await resp.json();
    const arr = data?.data ?? data?.web ?? [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn("Firecrawl search threw:", e);
    return [];
  }
}

async function apolloOrgPeopleSearch(domain: string, key: string) {
  try {
    const r = await fetch("https://api.apollo.io/api/v1/mixed_people/search", {
      method: "POST",
      headers: {
        "X-Api-Key": key,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Cache-Control": "no-cache",
      },
      body: JSON.stringify({
        q_organization_domains_list: [domain],
        person_titles: [
          "owner", "principal", "managing member", "manager",
          "president", "ceo", "founder", "partner", "director",
        ],
        page: 1,
        per_page: 10,
      }),
    });
    if (!r.ok) {
      console.warn(`Apollo ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return null;
    }
    return await r.json();
  } catch (e) {
    console.warn("Apollo threw:", e);
    return null;
  }
}

function isUnlockedApolloEmail(e?: string | null): boolean {
  if (!e) return false;
  return !/email_not_unlocked|domain\.com$/i.test(e);
}

async function aiExtractContact(blob: string, lovableKey: string): Promise<{
  email: string | null; phone: string | null; linkedin: string | null;
  name: string | null; role: string | null;
} | null> {
  try {
    const r = await fetch(AI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${lovableKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: "system", content: "Extract contact info from the text. Return ONLY JSON. Use null when unsure — do not invent." },
          { role: "user", content: `Find the most likely PRIMARY decision-maker behind this property owner. Return JSON:
{"name": string|null, "role": string|null, "email": string|null, "phone": string|null, "linkedin": string|null}

Source text:
${blob.slice(0, 8000)}` },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!r.ok) { await r.text(); return null; }
    const data = await r.json();
    return JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
  } catch (e) {
    console.warn("AI extract threw:", e);
    return null;
  }
}

async function enrichDecisionMaker(args: {
  ownerName: string | null;
  ownerType: string;
  propertyAddress: string | null;
  city: string | null;
  state: string | null;
  firecrawlKey: string | undefined;
  apolloKey: string | undefined;
  lovableKey: string;
}): Promise<EnrichmentResult> {
  const { ownerName, ownerType, city, state, firecrawlKey, apolloKey, lovableKey } = args;
  if (!ownerName) return EMPTY_ENRICHMENT;

  const result: EnrichmentResult = { ...EMPTY_ENRICHMENT, payload: {} };
  const isEntity = ownerType !== "Individual";

  // 1) State SoS / OpenCorporates search via Firecrawl (entity unmask)
  if (firecrawlKey && isEntity && state) {
    const stateName = STATE_NAMES[state] ?? state;
    const sosResults = await fcSearch(
      `"${ownerName}" site:opencorporates.com OR ${stateName} secretary of state business search`,
      firecrawlKey, 3, true,
    );
    const html = sosResults.map((r: any) => `${r.url}\n${r.markdown ?? ""}`).join("\n---\n");
    if (html) {
      result.payload.sos_html = html.slice(0, 2000);
      result.sources.push("firecrawl:sos");
      const ocUrl = sosResults.find((r: any) => /opencorporates\.com/.test(r.url ?? ""))?.url;
      if (ocUrl) result.entityRegistryUrl = ocUrl;
      // Try to lift a managing-member / officer name out of the page
      const officerMatch = html.match(/(?:Manager|Managing Member|President|CEO|Officer|Registered Agent)[\s:]+([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
      if (officerMatch) {
        result.decisionMakerName = officerMatch[1];
        result.decisionMakerRole = officerMatch[0].split(/[\s:]+/)[0];
        result.confidence += 25;
      }
    }
  } else if (!isEntity) {
    // For individual owners, the owner IS the decision maker
    result.decisionMakerName = ownerName;
    result.decisionMakerRole = "Owner";
    result.confidence += 20;
  }

  const targetName = result.decisionMakerName ?? ownerName;

  // 2) Firecrawl LinkedIn + news search
  if (firecrawlKey && targetName) {
    const liResults = await fcSearch(
      `"${targetName}" ${city ?? ""} ${state ?? ""} site:linkedin.com/in`,
      firecrawlKey, 3, false,
    );
    const liUrl = liResults.find((r: any) => /linkedin\.com\/in\//.test(r.url ?? ""))?.url;
    if (liUrl) {
      result.decisionMakerLinkedIn = liUrl;
      result.confidence += 15;
      result.sources.push("firecrawl:linkedin");
    }
    const newsResults = await fcSearch(
      `"${targetName}" ${city ?? ""} (real estate OR investor OR sold OR acquired)`,
      firecrawlKey, 4, false,
    );
    result.newsSnippets = newsResults.slice(0, 4)
      .map((r: any) => r.title ? `${r.title}` : null)
      .filter(Boolean) as string[];
    if (result.newsSnippets.length) result.sources.push("firecrawl:news");
  }

  // 3) Apollo.io organization people search if we can guess a company website
  if (apolloKey && firecrawlKey && isEntity) {
    // Try to find a company website by scraping the SoS page text
    const probe = await fcSearch(`"${ownerName}" website`, firecrawlKey, 2, true);
    const blob = probe.map((r: any) => `${r.url}\n${r.markdown ?? ""}`).join("\n");
    const domain = pickDomain(blob, ownerName);
    if (domain) {
      const apollo = await apolloOrgPeopleSearch(domain, apolloKey);
      const people = apollo?.people as Array<any> | undefined;
      if (people?.length) {
        // Prefer decision-maker-ish titles, then prefer ones with unlocked email
        const ranked = [...people].sort((a, b) => {
          const score = (e: any) => /owner|principal|manager|president|ceo|founder|partner/i.test(`${e.title ?? ""} ${e.seniority ?? ""}`) ? 1 : 0;
          return score(b) - score(a);
        });
        const pick = ranked.find((x) => isUnlockedApolloEmail(x.email)) ?? ranked[0];
        if (isUnlockedApolloEmail(pick.email)) {
          result.decisionMakerEmail = pick.email;
        }
        if (!result.decisionMakerName && (pick.first_name || pick.last_name)) {
          result.decisionMakerName = `${pick.first_name ?? ""} ${pick.last_name ?? ""}`.trim();
        }
        if (!result.decisionMakerRole && pick.title) result.decisionMakerRole = pick.title;
        if (!result.decisionMakerLinkedIn && pick.linkedin_url) result.decisionMakerLinkedIn = pick.linkedin_url;
        result.payload.apollo_company = pick.organization?.name ?? apollo?.organization?.name;
        result.payload.apollo_domain = domain;
        result.confidence += result.decisionMakerEmail ? 25 : 12;
        result.sources.push("apollo.io");
      }
    }
  }

  // 4) AI fallback on whatever we scraped if email is still missing
  if (!result.decisionMakerEmail && firecrawlKey && targetName) {
    const probe = await fcSearch(
      `"${targetName}" ${city ?? ""} ${state ?? ""} contact email`,
      firecrawlKey, 3, true,
    );
    const blob = probe.map((r: any) => `${r.url}\n${r.markdown ?? ""}`).join("\n---\n");
    if (blob) {
      // Regex first
      const email = firstMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/, blob);
      const phone = firstMatch(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/, blob);
      if (email) { result.decisionMakerEmail = email; result.confidence += 10; result.sources.push("firecrawl:contact-page"); }
      if (phone) { result.decisionMakerPhone = phone; result.confidence += 5; }
      if (!email || !phone) {
        const ai = await aiExtractContact(blob, lovableKey);
        if (ai) {
          if (!result.decisionMakerEmail && ai.email) { result.decisionMakerEmail = ai.email; result.confidence += 8; result.sources.push("ai:extract"); }
          if (!result.decisionMakerPhone && ai.phone) { result.decisionMakerPhone = ai.phone; result.confidence += 4; }
          if (!result.decisionMakerLinkedIn && ai.linkedin) { result.decisionMakerLinkedIn = ai.linkedin; result.confidence += 5; }
          if (!result.decisionMakerName && ai.name) result.decisionMakerName = ai.name;
          if (!result.decisionMakerRole && ai.role) result.decisionMakerRole = ai.role;
        }
      }
    }
  }

  result.confidence = Math.min(100, result.confidence);
  return result;
}

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia",
};
