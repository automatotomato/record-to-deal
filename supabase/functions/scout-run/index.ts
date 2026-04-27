// Scout agent: scrape public deed/recorder records for enabled counties
// using Firecrawl, then upsert candidate leads into the leads table.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FIRECRAWL_V2 = "https://api.firecrawl.dev/v2";

// Source URLs (public, no login). These are the landing/search pages we ask
// Firecrawl to render + extract structured records from. The county row
// `source_url` overrides this when present.
// One focused query per county to stay within edge function timeout (~60s).
const COUNTY_SOURCES: Record<string, { queries: string[]; hint: string }> = {
  la_county_recorder: {
    queries: [
      "Los Angeles multifamily OR commercial property recently sold owner LLC 2026",
    ],
    hint:
      "Recent Los Angeles County (CA) property transfers — multifamily, commercial, or investment SFR. Extract owner name, address, sale price/date when visible.",
  },
  cook_county_recorder: {
    queries: [
      "Chicago Cook County multifamily OR commercial property recently sold owner LLC 2026",
    ],
    hint:
      "Recent Cook County (IL) / Chicago property transfers — multifamily, commercial, or investment SFR. Extract owner name, address, sale price/date when visible.",
  },
};

interface ExtractedLead {
  owner_name?: string;
  property_address?: string;
  property_city?: string;
  property_zip?: string;
  parcel_number?: string;
  sale_price?: number;
  sale_date?: string; // YYYY-MM-DD
  deed_date?: string;
  property_type?: string;
  source_record_url?: string;
  trigger_event?: string;
}

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    leads: {
      type: "array",
      items: {
        type: "object",
        properties: {
          owner_name: { type: "string" },
          property_address: { type: "string" },
          property_city: { type: "string" },
          property_zip: { type: "string" },
          parcel_number: { type: "string" },
          sale_price: { type: "number" },
          sale_date: { type: "string", description: "ISO date YYYY-MM-DD" },
          deed_date: { type: "string", description: "ISO date YYYY-MM-DD" },
          property_type: {
            type: "string",
            enum: [
              "SFR",
              "Multifamily",
              "Commercial",
              "Land",
              "Industrial",
              "Mixed",
              "Unknown",
            ],
          },
          source_record_url: { type: "string" },
          trigger_event: {
            type: "string",
            enum: [
              "recent_sale",
              "listed_for_sale",
              "long_hold_owner",
              "trust_transfer",
              "off_market_signal",
            ],
          },
        },
      },
    },
  },
  required: ["leads"],
};

async function firecrawlSearchAndExtract(
  query: string,
  hint: string,
  apiKey: string,
): Promise<{ leads: ExtractedLead[]; sourceUrls: string[] }> {
  const resp = await fetch(`${FIRECRAWL_V2}/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      limit: 6,
      tbs: "qdr:m", // last month
      scrapeOptions: {
        onlyMainContent: true,
        formats: [
          "markdown",
          {
            type: "json",
            schema: EXTRACTION_SCHEMA,
            prompt:
              `${hint} Return up to 10 distinct property transfers found on this page. ` +
              `Use ISO dates. Skip any record without at least an address or owner name.`,
          },
        ],
      },
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(
      `Firecrawl ${resp.status}: ${JSON.stringify(data).slice(0, 400)}`,
    );
  }
  // Response: { success, data: { web: [{ url, json: { leads: [...] } }] } } (v2 SDK shape)
  // Older shape: { data: [{ url, json: {...} }] }
  const results: Array<Record<string, unknown>> =
    (data?.data?.web as Array<Record<string, unknown>>) ??
    (Array.isArray(data?.data) ? data.data : []) ??
    [];
  const aggregated: ExtractedLead[] = [];
  const sourceUrls: string[] = [];
  for (const r of results) {
    const url = (r?.url as string) ?? "";
    if (url) sourceUrls.push(url);
    const json = (r?.json as { leads?: ExtractedLead[] } | undefined) ??
      ((r?.extract as { leads?: ExtractedLead[] } | undefined));
    const leads = Array.isArray(json?.leads) ? json!.leads! : [];
    for (const lead of leads) {
      if (!lead.source_record_url && url) lead.source_record_url = url;
      aggregated.push(lead);
    }
  }
  return { leads: aggregated, sourceUrls };
}

function inferOwnerType(name?: string) {
  if (!name) return "Unknown";
  const n = name.toLowerCase();
  if (/\bllc\b|\bl\.l\.c\b/.test(n)) return "LLC";
  if (/\btrust\b|\btrustee\b/.test(n)) return "Trust";
  if (/\bcorp\b|\binc\b|\bcompany\b|\bco\.\b/.test(n)) return "Corporation";
  if (/\bestate of\b/.test(n)) return "Estate";
  return "Individual";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");

  if (!firecrawlKey) {
    return new Response(
      JSON.stringify({ error: "FIRECRAWL_API_KEY not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // Identify caller (optional)
  let triggeredBy: string | null = null;
  try {
    const auth = req.headers.get("Authorization");
    if (auth) {
      const token = auth.replace("Bearer ", "");
      const { data } = await supabase.auth.getUser(token);
      triggeredBy = data?.user?.id ?? null;
    }
  } catch (_) { /* ignore */ }

  let body: { county_ids?: string[]; trigger_kind?: string } = {};
  try { body = await req.json(); } catch (_) { /* no body */ }

  // Create a scout run row
  const { data: runRow, error: runErr } = await supabase
    .from("scout_runs")
    .insert({
      trigger_kind: body.trigger_kind ?? "manual",
      triggered_by: triggeredBy,
      status: "running",
    })
    .select()
    .single();
  if (runErr) {
    return new Response(JSON.stringify({ error: runErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Load enabled counties
  let countyQuery = supabase.from("counties").select("*").eq("enabled", true);
  if (body.county_ids?.length) {
    countyQuery = countyQuery.in("id", body.county_ids);
  }
  const { data: counties, error: cErr } = await countyQuery;
  if (cErr) {
    await supabase.from("scout_runs").update({
      status: "failed",
      finished_at: new Date().toISOString(),
      errors: [{ message: cErr.message }],
    }).eq("id", runRow.id);
    return new Response(JSON.stringify({ error: cErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const errors: Array<{ county: string; message: string }> = [];
  let totalFound = 0;
  let countiesScanned = 0;

  for (const county of counties ?? []) {
    const source = COUNTY_SOURCES[county.parser_key];
    const queries = source?.queries ?? [
      `${county.county} ${county.state} recent property sale owner LLC`,
    ];
    const hint = source?.hint ??
      `${county.county}, ${county.state} recent property transfers. Extract owner name, address, sale price/date.`;

    try {
      const extracted: ExtractedLead[] = [];
      for (const q of queries) {
        try {
          const { leads } = await firecrawlSearchAndExtract(q, hint, firecrawlKey);
          extracted.push(...leads);
        } catch (qe) {
          const msg = qe instanceof Error ? qe.message : String(qe);
          console.warn(`Query failed [${q}]:`, msg);
          errors.push({ county: county.county, message: `query "${q}": ${msg}` });
        }
      }
      countiesScanned += 1;
      console.log(`${county.county}: extracted ${extracted.length} candidate leads`);

      for (const lead of extracted) {
        if (!lead.property_address && !lead.parcel_number) continue;

        const dedupeFilter = lead.parcel_number
          ? { parcel_number: lead.parcel_number, county_id: county.id }
          : { property_address: lead.property_address!, county_id: county.id };

        const { data: existing } = await supabase
          .from("leads")
          .select("id")
          .match(dedupeFilter)
          .maybeSingle();

        const payload = {
          county_id: county.id,
          state: county.state,
          county: county.county,
          owner_name: lead.owner_name ?? null,
          owner_type: inferOwnerType(lead.owner_name),
          property_address: lead.property_address ?? null,
          property_city: lead.property_city ?? null,
          property_zip: lead.property_zip ?? null,
          parcel_number: lead.parcel_number ?? null,
          property_type: lead.property_type ?? "Unknown",
          sale_price: lead.sale_price ?? null,
          sale_date: lead.sale_date ?? null,
          deed_date: lead.deed_date ?? lead.sale_date ?? null,
          trigger_event: lead.trigger_event ?? "recent_sale",
          source_record_url: lead.source_record_url ?? null,
          data_sources: ["firecrawl_search", county.parser_key],
          scout_confidence: 55,
        };

        if (existing?.id) {
          await supabase.from("leads").update(payload).eq("id", existing.id);
        } else {
          const { data: inserted } = await supabase
            .from("leads")
            .insert(payload)
            .select("id")
            .single();
          if (inserted?.id) {
            totalFound += 1;
            await supabase.from("lead_activities").insert({
              lead_id: inserted.id,
              kind: "scout_found",
              summary: `Scouted from ${county.county}, ${county.state}`,
              payload: { source_url: lead.source_record_url, run_id: runRow.id },
            });
          }
        }
      }

      await supabase
        .from("counties")
        .update({ last_run_at: new Date().toISOString() })
        .eq("id", county.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Scout failed for ${county.county}:`, msg);
      errors.push({ county: county.county, message: msg });
    }
  }

  await supabase.from("scout_runs").update({
    status: errors.length && countiesScanned === 0 ? "failed" : "completed",
    finished_at: new Date().toISOString(),
    counties_scanned: countiesScanned,
    leads_found: totalFound,
    errors,
  }).eq("id", runRow.id);

  return new Response(
    JSON.stringify({
      run_id: runRow.id,
      counties_scanned: countiesScanned,
      leads_found: totalFound,
      errors,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
