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
const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

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
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");

  if (!smartyId || !smartyToken || !lovableKey) {
    return new Response(
      JSON.stringify({ error: "SMARTY_AUTH_ID, SMARTY_AUTH_TOKEN, or LOVABLE_API_KEY not configured" }),
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

  // 1. Pull from Smarty: prefer cached smarty_key, fall back to address search
  let smarty: SmartyRecord | null = null;
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

  if (!smarty || !smarty.attributes) {
    await supabase.from("lead_activities").insert({
      lead_id: leadId,
      kind: "profiler_run",
      summary: "Smarty returned no match for this property",
      payload: { source: "smarty", matched: false },
    });
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Smarty returned no property match",
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
`.trim();

  const aiResp = await fetch(AI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lovableKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
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

  // Contact completeness: Smarty gives us mailing address reliably (50pts).
  // Email/phone/linkedin would come from a future skip-tracing step.
  let completeness = 0;
  if (mailingAddress) completeness += 50;
  if (ownerName) completeness += 20;

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
    wealth_signals: wealthSignals,
    contact_completeness: completeness,
    personality_type: profile.personality_type ?? null,
    motivation_type: profile.motivation_type ?? null,
    preferred_channel: profile.preferred_channel ?? null,
    pitch_angle: profile.pitch_angle ?? null,
    lv_property_recommendation: profile.lv_property_recommendation ?? null,
    profiler_summary: profile.profiler_summary ?? null,
    data_sources: Array.from(new Set([...(l as unknown as { data_sources?: string[] }).data_sources ?? [], "smarty.com"])),
  };

  const { error: updErr } = await supabase.from("leads").update(updates).eq("id", leadId);
  if (updErr) {
    return new Response(JSON.stringify({ error: updErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Draft email
  let emailId: string | null = null;
  if (profile.email_subject && profile.email_body) {
    await supabase
      .from("outreach_emails")
      .update({ status: "superseded" })
      .eq("lead_id", leadId)
      .eq("status", "draft");

    const { data: emailRow, error: emErr } = await supabase
      .from("outreach_emails")
      .insert({
        lead_id: leadId,
        subject: profile.email_subject,
        body: profile.email_body,
        to_email: null, // Smarty doesn't supply email; needs skip-trace
        status: "draft",
      })
      .select("id")
      .single();
    if (emErr) console.warn("Draft insert error:", emErr.message);
    emailId = emailRow?.id ?? null;
  }

  // Activity log with Smarty source URLs
  const sources = [
    `https://smarty.com/products/apis/us-property-data-api`,
    smartyKey ? `smarty_key:${smartyKey}` : null,
  ].filter(Boolean) as string[];

  await supabase.from("lead_activities").insert({
    lead_id: leadId,
    kind: "profiler_run",
    summary: `Profiled via Smarty — ${ownerName ?? "owner"}, mailing ${mailingAddress ? "✓" : "✗"}, ${wealthSignals.length} wealth signals`,
    payload: {
      source: "smarty",
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
