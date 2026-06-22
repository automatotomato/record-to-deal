// wealth-scan: pulls free public wealth signals about a lead's owner/decision-maker
// and writes them to leads.wealth_signals + leads.wealth_tier.
// Sources:
//   - FEC individual contributions (https://api.open.fec.gov, free, no key needed for low volume — uses DEMO_KEY fallback)
//   - SEC EDGAR full-text search (efts.sec.gov, free, no key)
//   - FAA aircraft registry (registry.faa.gov, scraped via Firecrawl)
// Triggers: queued by seller-discovery for leads with score >= 50.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FEC_KEY = Deno.env.get("FEC_API_KEY") || "DEMO_KEY";
const FC_KEY = Deno.env.get("FIRECRAWL_API_KEY");

type Signal = { source: string; kind: string; value: string; url?: string; confidence: number };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const body = await req.json().catch(() => ({}));
    let leadId = body?.lead_id;
    const jobId = body?.job_id;
    if (!leadId && jobId) {
      const { data: job } = await supabase.from("pipeline_jobs").select("lead_id").eq("id", jobId).maybeSingle();
      leadId = job?.lead_id ?? null;
    }
    if (!leadId) return jsonErr("lead_id required", 400);

    const { data: lead, error } = await supabase.from("leads").select("*").eq("id", leadId).maybeSingle();
    if (error || !lead) return finish(supabase, jobId, [], "lead not found", true);

    const subjectName = (lead.decision_maker_name || lead.owner_name || "").trim();
    if (!subjectName || subjectName.length < 4) {
      return finish(supabase, jobId, [], "no subject name");
    }

    const subjectState = (lead.state || "").toUpperCase();
    const subjectCity = lead.property_city || "";
    const signals: Signal[] = [];

    // 1) FEC individual contributions (≥ $10K cumulative)
    try {
      const url = `https://api.open.fec.gov/v1/schedules/schedule_a/?api_key=${FEC_KEY}&contributor_name=${encodeURIComponent(subjectName)}&min_amount=2000&per_page=20&sort=-contribution_receipt_amount`;
      const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (r.ok) {
        const j = await r.json();
        const results = (j?.results ?? []) as any[];
        const matches = results.filter((x) =>
          (x.contributor_state ?? "").toUpperCase() === subjectState ||
          (x.contributor_city ?? "").toLowerCase() === subjectCity.toLowerCase(),
        );
        const total = matches.reduce((s, x) => s + (Number(x.contribution_receipt_amount) || 0), 0);
        if (total >= 10_000) {
          signals.push({
            source: "FEC",
            kind: "political_donations",
            value: `$${Math.round(total).toLocaleString()} in ${matches.length} contributions`,
            url: `https://www.fec.gov/data/receipts/individual-contributions/?contributor_name=${encodeURIComponent(subjectName)}`,
            confidence: matches.length >= 3 ? 0.85 : 0.6,
          });
        } else if (matches.length > 0 && total >= 2_000) {
          signals.push({
            source: "FEC",
            kind: "political_donations_minor",
            value: `$${Math.round(total).toLocaleString()} in ${matches.length} contributions`,
            url: `https://www.fec.gov/data/receipts/individual-contributions/?contributor_name=${encodeURIComponent(subjectName)}`,
            confidence: 0.45,
          });
        }
      }
    } catch (e) { console.warn("FEC failed", e); }

    // 2) SEC EDGAR full-text search (insider filings, 13D/G, etc.)
    try {
      const q = encodeURIComponent(`"${subjectName}"`);
      const url = `https://efts.sec.gov/LATEST/search-index?q=${q}&forms=4,3,5,13D,13G,SC%2013D,SC%2013G&hits=5`;
      const r = await fetch(url, { signal: AbortSignal.timeout(12_000), headers: { "User-Agent": "1031-leads research@example.com" } });
      if (r.ok) {
        const j = await r.json();
        const hits = j?.hits?.hits ?? [];
        if (hits.length > 0) {
          const forms = [...new Set(hits.map((h: any) => h?._source?.form).filter(Boolean))].slice(0, 5);
          signals.push({
            source: "SEC_EDGAR",
            kind: "insider_or_holder",
            value: `${hits.length} filings (${forms.join(", ")})`,
            url: `https://efts.sec.gov/LATEST/search-index?q=${q}`,
            confidence: 0.7,
          });
        }
      }
    } catch (e) { console.warn("EDGAR failed", e); }

    // 3) FAA aircraft registry (Firecrawl, optional, gated)
    if (FC_KEY) {
      const resId = await (async () => {
        try { const { data } = await supabase.rpc("fc_reserve", { p_caller: "wealth-scan:faa", p_credits: 1 }); return (data as string) ?? null; }
        catch { return null; }
      })();
      if (!resId) { console.warn("fc_throttled wealth-scan"); }
      else {
        try {
          const url = `https://registry.faa.gov/AircraftInquiry/Search/NameInquiry?nametxt=${encodeURIComponent(subjectName)}&sort_option=2&PageNo=1`;
          const r = await fetch("https://api.firecrawl.dev/v2/scrape", {
            method: "POST",
            headers: { "Authorization": `Bearer ${FC_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
            signal: AbortSignal.timeout(20_000),
          });
          if (r.ok) {
            const j = await r.json();
            await supabase.rpc("fc_release", { p_id: resId, p_actual: 1, p_status: "done" });
            const md: string = j?.markdown ?? j?.data?.markdown ?? "";
            if (md && /N\d{2,5}[A-Z]{0,2}/.test(md) && /aircraft/i.test(md)) {
              const tail = md.match(/N\d{2,5}[A-Z]{0,2}/g)?.[0];
              signals.push({
                source: "FAA",
                kind: "aircraft_owner",
                value: tail ? `Aircraft tail ${tail}` : "Aircraft registration found",
                url,
                confidence: 0.65,
              });
            }
          } else {
            await supabase.rpc("fc_release", { p_id: resId, p_actual: 1, p_status: "failed" });
          }
        } catch (e) { console.warn("FAA failed", e); await supabase.rpc("fc_release", { p_id: resId, p_actual: 1, p_status: "failed" }); }
      }
    }


    // 4) Score → wealth tier
    const hasWhaleSignal = signals.some((s) =>
      s.kind === "aircraft_owner" ||
      (s.kind === "political_donations" && /\$1\d{2},|\$\d{3},\d{3}|\$\d,\d{3},\d{3}/.test(s.value)) ||
      s.kind === "insider_or_holder",
    );
    const salePrice = Number(lead.sale_price ?? 0);
    let tier: "whale" | "affluent" | "standard" | "unknown" = lead.wealth_tier ?? "unknown";
    if (hasWhaleSignal || salePrice >= 5_000_000) tier = "whale";
    else if (signals.length > 0 || salePrice >= 1_500_000) tier = "affluent";
    else tier = "standard";

    await supabase.from("leads").update({
      wealth_signals: signals,
      wealth_tier: tier,
      updated_at: new Date().toISOString(),
    }).eq("id", leadId);

    await supabase.from("lead_activities").insert({
      lead_id: leadId,
      kind: "wealth_scan",
      summary: `Wealth scan: tier=${tier} · ${signals.length} signal${signals.length === 1 ? "" : "s"}`,
      payload: { tier, signals },
    });

    // Whales jump the brief queue
    if (tier === "whale") {
      await supabase.from("pipeline_jobs").insert({
        kind: "lead_brief", lead_id: leadId, priority: 30,
      });
    }

    return finish(supabase, jobId, signals);
  } catch (e: any) {
    return jsonErr(e?.message ?? "unknown error", 500);
  }
});

async function finish(supabase: any, jobId: string | undefined, signals: Signal[], msg?: string, fail = false) {
  if (jobId) {
    await supabase.from("pipeline_jobs").update({
      status: fail ? "failed" : "done",
      finished_at: new Date().toISOString(),
      last_error: fail ? msg : null,
      result: { signals_found: signals.length },
    }).eq("id", jobId);
  }
  return new Response(JSON.stringify({ ok: !fail, signals, error: fail ? msg : undefined }), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function jsonErr(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
