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
  lovableKey: string,
): Promise<{ leads: ExtractedLead[]; sourceUrls: string[] }> {
  // Step 1: Firecrawl search with markdown scrape (no LLM extraction here -
  // doing it inline blows past the edge function timeout).
  const resp = await fetch(`${FIRECRAWL_V2}/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      limit: 4,
      tbs: "qdr:m",
      scrapeOptions: { onlyMainContent: true, formats: ["markdown"] },
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(
      `Firecrawl search ${resp.status}: ${JSON.stringify(data).slice(0, 400)}`,
    );
  }
  const results: Array<Record<string, unknown>> =
    (data?.data?.web as Array<Record<string, unknown>>) ??
    (Array.isArray(data?.data) ? data.data : []) ??
    [];
  const sourceUrls: string[] = [];
  const corpus: string[] = [];
  for (const r of results) {
    const url = (r?.url as string) ?? "";
    const title = (r?.title as string) ?? "";
    const md = (r?.markdown as string) ?? (r?.description as string) ?? "";
    if (url) sourceUrls.push(url);
    corpus.push(`### ${title}\nURL: ${url}\n\n${md.slice(0, 4000)}`);
  }

  if (!corpus.length) return { leads: [], sourceUrls };

  // Step 2: One LLM extraction pass via Lovable AI Gateway over all results.
  const aiResp = await fetch(
    "https://ai.gateway.lovable.dev/v1/chat/completions",
    {
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
              "You extract structured property-transfer leads from web content. " +
              "Return ONLY valid JSON matching the provided schema. Skip records without an address or owner name.",
          },
          {
            role: "user",
            content: `${hint}\n\nReturn JSON: { "leads": [ { owner_name, property_address, property_city, property_zip, parcel_number, sale_price (number, no $/commas), sale_date (YYYY-MM-DD), deed_date (YYYY-MM-DD), property_type (one of SFR|Multifamily|Commercial|Land|Industrial|Mixed|Unknown), source_record_url, trigger_event (one of recent_sale|listed_for_sale|long_hold_owner|trust_transfer|off_market_signal) } ] }\n\nWeb content:\n\n${corpus.join("\n\n---\n\n").slice(0, 18000)}`,
          },
        ],
        response_format: { type: "json_object" },
      }),
    },
  );
  if (!aiResp.ok) {
    const t = await aiResp.text();
    throw new Error(`AI extract ${aiResp.status}: ${t.slice(0, 300)}`);
  }
  const aiData = await aiResp.json();
  const content = aiData?.choices?.[0]?.message?.content ?? "{}";
  let parsed: { leads?: ExtractedLead[] } = {};
  try { parsed = JSON.parse(content); } catch { /* ignore */ }
  const leads = Array.isArray(parsed.leads) ? parsed.leads : [];
  for (const lead of leads) {
    if (!lead.source_record_url && sourceUrls[0]) lead.source_record_url = sourceUrls[0];
  }
  return { leads, sourceUrls };
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
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");

  if (!firecrawlKey || !lovableKey) {
    return new Response(
      JSON.stringify({ error: "FIRECRAWL_API_KEY or LOVABLE_API_KEY not configured" }),
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

  // Mark any previous "running" runs older than 2 minutes as failed (stale)
  await supabase
    .from("scout_runs")
    .update({
      status: "failed",
      finished_at: new Date().toISOString(),
      errors: [{ message: "timed out / abandoned" }],
    })
    .eq("status", "running")
    .lt("started_at", new Date(Date.now() - 2 * 60 * 1000).toISOString());

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

  // Run the scrape + extraction in the background so the HTTP response can
  // return immediately. The frontend polls scout_runs to learn the outcome.
  const work = async () => {
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
          const { leads } = await firecrawlSearchAndExtract(q, hint, firecrawlKey, lovableKey);
          extracted.push(...leads);
        } catch (qe) {
          const msg = qe instanceof Error ? qe.message : String(qe);
          console.warn(`Query failed [${q}]:`, msg);
          errors.push({ county: county.county, message: `query "${q}": ${msg}` });
        }
      }
      countiesScanned += 1;
      console.log(`${county.county}: extracted ${extracted.length} candidate leads`);

      // Build payloads, dedupe in-batch first
      const seen = new Set<string>();
      const payloads = [];
      for (const lead of extracted) {
        if (!lead.property_address && !lead.parcel_number) continue;
        const key = `${lead.parcel_number ?? ""}|${lead.property_address ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        payloads.push({
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
        });
      }

      if (payloads.length) {
        // Bulk fetch existing matches in one query
        const addresses = payloads.map((p) => p.property_address).filter(Boolean) as string[];
        const { data: existing } = await supabase
          .from("leads")
          .select("id, property_address, parcel_number")
          .eq("county_id", county.id)
          .or(
            addresses.length
              ? `property_address.in.(${addresses.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(",")})`
              : "id.is.null",
          );
        const existingByAddr = new Map((existing ?? []).map((r) => [r.property_address, r.id]));

        const toInsert = payloads.filter((p) => !existingByAddr.has(p.property_address));
        const toUpdate = payloads.filter((p) => existingByAddr.has(p.property_address));

        if (toInsert.length) {
          const { data: inserted, error: insErr } = await supabase
            .from("leads")
            .insert(toInsert)
            .select("id");
          if (insErr) console.error("Bulk insert error:", insErr.message);
          if (inserted?.length) {
            totalFound += inserted.length;
            await supabase.from("lead_activities").insert(
              inserted.map((row) => ({
                lead_id: row.id,
                kind: "scout_found",
                summary: `Scouted from ${county.county}, ${county.state}`,
                payload: { run_id: runRow.id },
              })),
            );
          }
        }
        // Updates run in parallel (fire-and-forget chunks)
        await Promise.all(
          toUpdate.map((p) =>
            supabase
              .from("leads")
              .update(p)
              .eq("id", existingByAddr.get(p.property_address)!),
          ),
        );
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
  };

  // @ts-ignore - EdgeRuntime is provided by Supabase edge runtime
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(work());
  } else {
    work().catch((e) => console.error("Background work failed:", e));
  }

  return new Response(
    JSON.stringify({ run_id: runRow.id, status: "running", message: "Scout started in background. Poll scout_runs for results." }),
    { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
});
