// scan-presale: finds ACTIVE for-sale investment-property listings on Crexi
// and LoopNet for a given state. Inserts leads at pipeline_stage = 'pre_sale_prospect'
// so they show up in the Pre-sale tab. These leads are NOT eligible for
// contact-hunt enrichment until a human moves them forward.
//
// Payload: { state: "TX", scout_run_id?: uuid, job_id?: uuid }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { fcSearch } from "../_shared/firecrawl.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const STATE_NAMES: Record<string, string> = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",
  CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",
  IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",
  ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",
  MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",
  NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",
  OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",
  SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",
  WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",DC:"District of Columbia",
};

interface Listing {
  source: "crexi" | "loopnet";
  source_url: string;
  title: string | null;
  property_address: string | null;
  property_city: string | null;
  state: string;
  asking_price: number | null;
}

const NUM = (s?: string | null) => {
  if (!s) return null;
  const m = String(s).match(/\$?\s*([\d,]+(?:\.\d+)?)\s*([mMkK]?)/);
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  if (m[2] === "M" || m[2] === "m") return Math.round(base * 1_000_000);
  if (m[2] === "K" || m[2] === "k") return Math.round(base * 1_000);
  return Math.round(base);
};

function extractAddress(title: string | null, markdown: string | null): { addr: string | null; city: string | null } {
  const text = `${title ?? ""}\n${markdown ?? ""}`;
  // very loose street + city
  const m = text.match(/(\d{2,6}\s+[A-Z][A-Za-z0-9.\- ]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Parkway|Pkwy|Highway|Hwy))[ ,]+([A-Z][A-Za-z .\-]+)/);
  if (!m) return { addr: null, city: null };
  return { addr: m[1].trim(), city: m[2].trim().replace(/[,.\s]+$/, "") };
}

async function searchListings(state: string): Promise<Listing[]> {
  const stateFull = STATE_NAMES[state] ?? state;
  const queries: { q: string; source: "crexi" | "loopnet" }[] = [
    { source: "crexi",   q: `site:crexi.com "${stateFull}" "for sale" (multifamily OR industrial OR retail OR office)` },
    { source: "loopnet", q: `site:loopnet.com "${stateFull}" "for sale" (multifamily OR industrial OR retail OR office)` },
  ];
  const out: Listing[] = [];
  for (const { q, source } of queries) {
    const results = await fcSearch("scan-presale", q, { limit: 8, scrape: true, tbs: "qdr:m" });
    for (const r of results) {
      const url = r.url ?? "";
      if (!url) continue;
      if (source === "crexi"   && !/crexi\.com\/properties\//i.test(url)) continue;
      if (source === "loopnet" && !/loopnet\.com\/Listing\//i.test(url)) continue;
      const { addr, city } = extractAddress(r.title ?? null, r.markdown ?? r.description ?? null);
      const priceMatch = (r.markdown ?? r.description ?? "").match(/\$\s?[\d,.]+\s?[mMkK]?/);
      out.push({
        source, source_url: url, title: r.title ?? null,
        property_address: addr, property_city: city, state,
        asking_price: priceMatch ? NUM(priceMatch[0]) : null,
      });
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: { state?: string; job_id?: string; scout_run_id?: string } = {};
  try { body = await req.json(); } catch (_) {}
  const jobId = body.job_id;
  let state = body.state;

  if (!state && jobId) {
    const { data: job } = await supabase.from("pipeline_jobs").select("payload").eq("id", jobId).maybeSingle();
    state = (job?.payload as any)?.state;
  }
  if (!state) return jsonErr("state required", 400);

  let inserted = 0, skipped = 0;
  try {
    const listings = await searchListings(state);
    for (const l of listings) {
      if (!l.source_url) { skipped++; continue; }
      // Dedupe on source_url (we re-use the public source_record_url column).
      const { data: existing } = await supabase
        .from("leads").select("id").eq("source_record_url", l.source_url).maybeSingle();
      if (existing) { skipped++; continue; }

      await supabase.from("leads").insert({
        state: l.state,
        property_address: l.property_address ?? l.title ?? l.source_url,
        property_city: l.property_city,
        property_type: "Investment",
        sale_price: l.asking_price,           // asking, not sold
        owner_name: null,
        owner_type: "Unknown",
        pipeline_stage: "pre_sale_prospect",
        discovery_status: "pending",
        readiness: "researching",
        data_sources: [`${l.source}:listing`],
        source_record_url: l.source_url,
        is_urgent: false,
      });
      inserted++;
    }
  } catch (e: any) {
    if (jobId) {
      await supabase.from("pipeline_jobs").update({
        status: "failed", finished_at: new Date().toISOString(),
        last_error: e?.message ?? "scan-presale threw",
      }).eq("id", jobId);
    }
    return jsonErr(e?.message ?? "scan-presale error", 500);
  }

  if (jobId) {
    await supabase.from("pipeline_jobs").update({
      status: "done", finished_at: new Date().toISOString(),
      result: { state, inserted, skipped },
    }).eq("id", jobId);
  }
  return new Response(JSON.stringify({ ok: true, state, inserted, skipped }), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

function jsonErr(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
