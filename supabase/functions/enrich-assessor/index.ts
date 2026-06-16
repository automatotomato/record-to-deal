// enrich-assessor: takes one lead, looks up its county assessor record via the
// per-county adapter in _shared/assessor-sources.ts, and fills mailing address,
// assessed/market value, year built, lot/building sqft, last assessor sale,
// and owner_occupied (mailing == property). Counties without an adapter exit
// cheaply with assessor_status='unsupported_county'.
//
// Service-role only (dispatcher invokes via service-role JWT). Job kind:
// enrich_assessor. Idempotent — skip if assessor_status='ok' and fetched <30
// days ago, unless { force: true } is in the payload.
//
// SECURITY: This endpoint can burn Firecrawl credits. It refuses any caller
// that does not present SUPABASE_SERVICE_ROLE_KEY in the Authorization header.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { findAssessorAdapter, lookupAssessor, norm } from "../_shared/assessor-sources.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonOk(b: unknown) {
  return new Response(JSON.stringify(b), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function jsonErr(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
async function markFailed(supabase: any, jobId: string | undefined, msg: string) {
  if (!jobId) return;
  await supabase.from("pipeline_jobs").update({
    status: "failed", finished_at: new Date().toISOString(), last_error: msg,
  }).eq("id", jobId);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const auth = req.headers.get("Authorization") ?? "";
  if (auth.replace(/^Bearer\s+/i, "") !== serviceKey) {
    return jsonErr("forbidden — service role required", 403);
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY_OVERRIDE") ?? Deno.env.get("FIRECRAWL_API_KEY");
  if (!firecrawlKey) return jsonErr("FIRECRAWL_API_KEY missing", 500);

  let body: { job_id?: string; lead_id?: string; force?: boolean } = {};
  try { body = await req.json(); } catch (_) {}

  let leadId = body.lead_id;
  if (!leadId && body.job_id) {
    const { data: job } = await supabase.from("pipeline_jobs").select("lead_id, payload").eq("id", body.job_id).maybeSingle();
    leadId = job?.lead_id ?? job?.payload?.lead_id ?? null;
  }
  if (!leadId) { await markFailed(supabase, body.job_id, "no lead_id"); return jsonErr("lead_id required", 400); }

  const { data: lead } = await supabase.from("leads").select("*").eq("id", leadId).maybeSingle();
  if (!lead) { await markFailed(supabase, body.job_id, "lead missing"); return jsonErr("lead not found", 404); }

  // Idempotency
  if (!body.force && lead.assessor_status === "ok" && lead.assessor_fetched_at) {
    const ageMs = Date.now() - new Date(lead.assessor_fetched_at).getTime();
    if (ageMs < 30 * 24 * 3600 * 1000) {
      if (body.job_id) {
        await supabase.from("pipeline_jobs").update({
          status: "done", finished_at: new Date().toISOString(),
          result: { skipped: "fresh_within_30d" },
        }).eq("id", body.job_id);
      }
      return jsonOk({ ok: true, skipped: "fresh_within_30d" });
    }
  }

  const adapter = findAssessorAdapter(lead.state, lead.county);
  if (!adapter) {
    await supabase.from("leads").update({
      assessor_status: "unsupported_county",
      assessor_fetched_at: new Date().toISOString(),
    }).eq("id", leadId);
    if (body.job_id) {
      await supabase.from("pipeline_jobs").update({
        status: "done", finished_at: new Date().toISOString(),
        result: { assessor_status: "unsupported_county" },
      }).eq("id", body.job_id);
    }
    return jsonOk({ ok: true, assessor_status: "unsupported_county" });
  }

  let record;
  try {
    record = await lookupAssessor(
      adapter,
      { address: lead.property_address, parcel: lead.parcel_number, city: lead.property_city, zip: lead.property_zip },
      firecrawlKey,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase.from("leads").update({
      assessor_status: "error",
      assessor_fetched_at: new Date().toISOString(),
    }).eq("id", leadId);
    await markFailed(supabase, body.job_id, msg);
    return jsonOk({ ok: false, error: msg });
  }

  if (!record) {
    await supabase.from("leads").update({
      assessor_status: "not_found",
      assessor_fetched_at: new Date().toISOString(),
      assessor_url: adapter.searchUrl({ address: lead.property_address, parcel: lead.parcel_number }),
    }).eq("id", leadId);
    if (body.job_id) {
      await supabase.from("pipeline_jobs").update({
        status: "done", finished_at: new Date().toISOString(),
        result: { assessor_status: "not_found" },
      }).eq("id", body.job_id);
    }
    return jsonOk({ ok: true, assessor_status: "not_found" });
  }

  const ownerOccupied = record.mailing_address && lead.property_address
    ? norm(record.mailing_address).includes(norm(lead.property_address)) ||
      norm(lead.property_address).includes(norm(record.mailing_address))
    : null;

  await supabase.from("leads").update({
    mailing_address: record.mailing_address ?? null,
    mailing_city: record.mailing_city ?? null,
    mailing_state: record.mailing_state ?? null,
    mailing_zip: record.mailing_zip ?? null,
    assessed_value: record.assessed_value ?? lead.assessed_value,
    market_value: record.market_value ?? null,
    year_built: record.year_built ?? null,
    lot_size_sqft: record.lot_size_sqft ?? null,
    building_sqft: record.building_sqft ?? null,
    assessor_last_sale_date: record.last_sale_date ?? null,
    assessor_last_sale_price: record.last_sale_price ?? null,
    owner_occupied: ownerOccupied,
    assessor_url: record.source_url,
    assessor_fetched_at: new Date().toISOString(),
    assessor_status: "ok",
    updated_at: new Date().toISOString(),
  }).eq("id", leadId);

  await supabase.from("lead_activities").insert({
    lead_id: leadId,
    kind: "assessor_enriched",
    summary: `Assessor (${adapter.id}) loaded: ${record.mailing_address ? "mailing " + (ownerOccupied ? "(owner-occupied)" : "(absentee)") : "values only"}`,
    payload: { adapter: adapter.id, source_url: record.source_url },
  });

  // If lead is in needs_review, kick it back to qualify now that we have signal.
  if (lead.pipeline_stage === "needs_review") {
    await supabase.from("pipeline_jobs").insert({
      kind: "qualify_lead", lead_id: leadId, priority: 80,
    });
  }

  if (body.job_id) {
    await supabase.from("pipeline_jobs").update({
      status: "done", finished_at: new Date().toISOString(),
      result: { assessor_status: "ok", owner_occupied: ownerOccupied },
    }).eq("id", body.job_id);
  }

  return jsonOk({ ok: true, assessor_status: "ok", owner_occupied: ownerOccupied });
});
