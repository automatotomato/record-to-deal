// Profiler agent: given a lead, search public records + the open web for the
// owner's contact details (email, phone, LinkedIn), build a personality
// profile, then draft a tailored outreach email. Persists everything back to
// the leads table and creates a draft outreach_emails row.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FIRECRAWL_V2 = "https://api.firecrawl.dev/v2";
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
}

interface ContactProfile {
  contact_email?: string;
  contact_phone?: string;
  contact_linkedin?: string;
  mailing_address?: string;
  wealth_signals?: Array<{ signal: string; source?: string }>;
  personality_type?: string;
  motivation_type?: string;
  preferred_channel?: string;
  pitch_angle?: string;
  lv_property_recommendation?: string;
  profiler_summary?: string;
  email_subject?: string;
  email_body?: string;
}

async function firecrawlScrape(
  url: string,
  apiKey: string,
): Promise<{ markdown: string; url: string } | null> {
  try {
    const resp = await fetch(`${FIRECRAWL_V2}/scrape`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        waitFor: 3000,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.warn(`Assessor scrape ${resp.status} for ${url}`);
      return null;
    }
    const md =
      (data?.data?.markdown as string) ??
      (data?.markdown as string) ??
      "";
    if (!md) return null;
    return { markdown: md.slice(0, 8000), url };
  } catch (e) {
    console.warn("Assessor scrape failed:", e);
    return null;
  }
}

// Try to fetch the official county assessor record for the property.
// Returns { corpus, source } when successful, null otherwise.
async function fetchCountyAssessor(
  lead: Lead,
  apiKey: string,
): Promise<{ corpus: string; source: string } | null> {
  const state = (lead.state ?? "").toUpperCase();
  const county = (lead.county ?? "").toLowerCase();
  const parcelRaw = (lead.parcel_number ?? "").trim();
  const parcelDigits = parcelRaw.replace(/[^0-9]/g, "");

  // LA County
  if (state === "CA" && county.includes("los angeles")) {
    if (parcelDigits.length >= 8) {
      const direct = await firecrawlScrape(
        `https://portal.assessor.lacounty.gov/parceldetail/${parcelDigits}`,
        apiKey,
      );
      if (direct?.markdown) return { corpus: direct.markdown, source: direct.url };
    }
    if (lead.property_address) {
      const search = await firecrawlSearch(
        `"${lead.property_address}" site:assessor.lacounty.gov`,
        apiKey,
        2,
      );
      if (search.corpus) return { corpus: search.corpus.slice(0, 8000), source: search.sources[0] ?? "assessor.lacounty.gov" };
    }
    return null;
  }

  // Cook County
  if (state === "IL" && county.includes("cook")) {
    if (parcelDigits.length >= 10) {
      const direct = await firecrawlScrape(
        `https://www.cookcountyassessor.com/pin/${parcelDigits}`,
        apiKey,
      );
      if (direct?.markdown) return { corpus: direct.markdown, source: direct.url };
    }
    if (lead.property_address) {
      const search = await firecrawlSearch(
        `"${lead.property_address}" site:cookcountyassessor.com`,
        apiKey,
        2,
      );
      if (search.corpus) return { corpus: search.corpus.slice(0, 8000), source: search.sources[0] ?? "cookcountyassessor.com" };
    }
    return null;
  }

  // Generic fallback for any other county
  if (lead.property_address || parcelRaw) {
    const q = parcelRaw
      ? `"${parcelRaw}" ${lead.county ?? ""} county assessor mailing address`
      : `"${lead.property_address}" ${lead.county ?? ""} ${state} assessor mailing address taxpayer`;
    const search = await firecrawlSearch(q, apiKey, 3);
    if (search.corpus) return { corpus: search.corpus.slice(0, 8000), source: search.sources[0] ?? "assessor" };
  }
  return null;
}

async function firecrawlSearch(
  query: string,
  apiKey: string,
  limit = 5,
): Promise<{ corpus: string; sources: string[] }> {
  try {
    const resp = await fetch(`${FIRECRAWL_V2}/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        limit,
        scrapeOptions: { onlyMainContent: true, formats: ["markdown"] },
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.warn(`Firecrawl ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
      return { corpus: "", sources: [] };
    }
    const results: Array<Record<string, unknown>> =
      (data?.data?.web as Array<Record<string, unknown>>) ??
      (Array.isArray(data?.data) ? data.data : []) ??
      [];
    const sources: string[] = [];
    const parts: string[] = [];
    for (const r of results) {
      const url = (r?.url as string) ?? "";
      const title = (r?.title as string) ?? "";
      const md = (r?.markdown as string) ?? (r?.description as string) ?? "";
      if (url) sources.push(url);
      parts.push(`### ${title}\nURL: ${url}\n\n${md.slice(0, 3000)}`);
    }
    return { corpus: parts.join("\n\n---\n\n"), sources };
  } catch (e) {
    console.warn("Firecrawl search failed:", e);
    return { corpus: "", sources: [] };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");

  if (!firecrawlKey || !lovableKey) {
    return new Response(
      JSON.stringify({ error: "FIRECRAWL_API_KEY or LOVABLE_API_KEY not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  let body: { lead_id?: string } = {};
  try { body = await req.json(); } catch (_) {}
  const leadId = body.lead_id;
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

  const l = lead as Lead;

  // Build search queries — different angles depending on owner type
  const ownerName = (l.owner_name ?? "").trim();
  const cityState = `${l.property_city ?? ""} ${l.state ?? ""}`.trim();
  const queries: string[] = [];
  if (ownerName) {
    queries.push(`"${ownerName}" ${cityState} contact email`);
    if (/llc|inc|corp|trust|company|co\.|holdings|properties|partners/i.test(ownerName)) {
      queries.push(`"${ownerName}" registered agent OR principal OR manager ${l.state ?? ""}`);
      queries.push(`"${ownerName}" linkedin OR opencorporates OR bizapedia`);
    } else {
      queries.push(`"${ownerName}" ${cityState} linkedin`);
      queries.push(`"${ownerName}" ${cityState} phone OR email`);
    }
  }
  if (l.property_address) {
    queries.push(`"${l.property_address}" ${cityState} owner contact`);
  }

  // 1. Fetch the official county assessor record FIRST (highest-trust source).
  // 2. Fan out web searches in parallel (cap to 4) for owner contact info.
  const [assessor, searchResults] = await Promise.all([
    fetchCountyAssessor(l, firecrawlKey),
    Promise.all(queries.slice(0, 4).map((q) => firecrawlSearch(q, firecrawlKey, 4))),
  ]);
  const corpus = searchResults.map((r) => r.corpus).filter(Boolean).join("\n\n===\n\n");
  const sources = Array.from(new Set([
    ...(assessor ? [assessor.source] : []),
    ...searchResults.flatMap((r) => r.sources),
  ]));
  const assessorBlock = assessor
    ? `=== OFFICIAL COUNTY ASSESSOR RECORD (TRUSTED — prefer this for mailing_address and taxpayer name) ===
Source: ${assessor.source}

${assessor.corpus}

=== END OFFICIAL RECORD ===

`
    : "";

  // AI: extract contact + profile + draft email in one pass
  const propertyContext = `
Property: ${l.property_address ?? "?"} · ${l.property_city ?? ""}, ${l.state ?? ""} ${l.property_zip ?? ""}
County: ${l.county ?? ""}
Type: ${l.property_type ?? "Unknown"}
Owner: ${l.owner_name ?? "Unknown"} (${l.owner_type ?? "Unknown"})
Sale price: ${l.sale_price ? `$${l.sale_price.toLocaleString()}` : "unknown"}
Sale date: ${l.sale_date ?? "unknown"}
Parcel: ${l.parcel_number ?? "—"}
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
            "You are a 1031-exchange outreach analyst. Given a property/owner record and snippets " +
            "from the open web (LinkedIn, business registries, property records, news), extract the " +
            "best available contact information for the owner (or for an LLC: its principal / registered " +
            "agent), build a brief personality + motivation profile, and draft a personalized cold " +
            "outreach email offering a 1031 exchange consultation into Las Vegas property. " +
            "ONLY include contact info you can directly support from the provided snippets — do NOT " +
            "invent emails or phone numbers. If nothing is found, leave those fields empty. " +
            "Return ONLY valid JSON.",
        },
        {
          role: "user",
          content: `${propertyContext}

${assessorBlock}Web research snippets:

${corpus.slice(0, 16000) || "(no web results found — work with the property record only)"}

Return JSON with this exact shape:
{
  "contact_email": "string or empty",
  "contact_phone": "string or empty",
  "contact_linkedin": "full URL or empty",
  "mailing_address": "string or empty",
  "wealth_signals": [{"signal": "short phrase", "source": "url or domain"}],
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
  let profile: ContactProfile = {};
  try { profile = JSON.parse(content); } catch (_) { /* ignore */ }

  // Compute contact_completeness score (max 100)
  let completeness = 0;
  if (profile.contact_email) completeness += 50;
  if (profile.contact_phone) completeness += 30;
  if (profile.contact_linkedin) completeness += 20;
  // Verified mailing address from county assessor → +10 (capped at 100)
  if (assessor && profile.mailing_address) completeness = Math.min(100, completeness + 10);
  const mailingFromAssessor = !!(assessor && profile.mailing_address);

  // Update lead row
  const updates: Record<string, unknown> = {
    contact_email: profile.contact_email || null,
    contact_phone: profile.contact_phone || null,
    contact_linkedin: profile.contact_linkedin || null,
    contact_completeness: completeness,
    mailing_address: profile.mailing_address || l.mailing_address || null,
    wealth_signals: Array.isArray(profile.wealth_signals) ? profile.wealth_signals : [],
    personality_type: profile.personality_type || null,
    motivation_type: profile.motivation_type || null,
    preferred_channel: profile.preferred_channel || null,
    pitch_angle: profile.pitch_angle || null,
    lv_property_recommendation: profile.lv_property_recommendation || null,
    profiler_summary: profile.profiler_summary || null,
  };

  const { error: updErr } = await supabase.from("leads").update(updates).eq("id", leadId);
  if (updErr) {
    return new Response(JSON.stringify({ error: updErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Insert (or replace latest) draft email
  let emailId: string | null = null;
  if (profile.email_subject && profile.email_body) {
    // Remove previous unsent drafts for this lead to keep things tidy
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
        to_email: profile.contact_email || null,
        status: "draft",
      })
      .select("id")
      .single();
    if (emErr) console.warn("Draft insert error:", emErr.message);
    emailId = emailRow?.id ?? null;
  }

  // Activity log
  await supabase.from("lead_activities").insert({
    lead_id: leadId,
    kind: "profiler_run",
    summary: `Profiled owner — completeness ${completeness}%${profile.contact_email ? `, email ${profile.contact_email}` : ", no email found"}`,
    payload: { sources: sources.slice(0, 10), completeness },
  });

  return new Response(
    JSON.stringify({
      ok: true,
      contact_completeness: completeness,
      contact_email: profile.contact_email ?? null,
      email_draft_id: emailId,
      sources,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
