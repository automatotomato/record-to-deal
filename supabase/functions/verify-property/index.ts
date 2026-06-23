// verify-property worker: takes a raw_candidate lead, runs Smarty address
// verification, dedupes against existing leads (parcel/address/owner+date),
// and either updates an existing lead OR keeps the new one. On success it
// enqueues a qualify_lead job. Job kind: verify_property.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SMARTY_SEARCH = "https://us-property.api.smarty.com/search";

const norm = (s: string | null | undefined) =>
  (s ?? "").toString().trim().toUpperCase().replace(/\s+/g, " ").replace(/[.,]/g, "");

async function smartyByAddress(
  street: string, city: string | null, state: string | null, zipcode: string | null,
  authId: string, authToken: string,
) {
  const params = new URLSearchParams({
    "auth-id": authId, "auth-token": authToken,
    license: "us-property-data-principal-cloud", street,
  });
  if (city) params.set("city", city);
  if (state) params.set("state", state);
  if (zipcode) params.set("zipcode", zipcode);
  try {
    const r = await fetch(`${SMARTY_SEARCH}/property/principal?${params}`, {
      headers: { "Content-Type": "application/json" },
    });
    if (!r.ok) return null;
    const data = await r.json();
    return Array.isArray(data) ? data[0] ?? null : null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const smartyId = Deno.env.get("SMARTY_AUTH_ID");
  const smartyToken = Deno.env.get("SMARTY_AUTH_TOKEN");

  let body: { job_id?: string } = {};
  try { body = await req.json(); } catch (_) {}
  if (!body.job_id) return jsonErr("job_id required", 400);

  const { data: job } = await supabase.from("pipeline_jobs").select("*").eq("id", body.job_id).maybeSingle();
  if (!job) return jsonErr("job not found", 404);

  const leadId = job.lead_id;
  if (!leadId) { await markFailed(supabase, body.job_id, "no lead_id"); return jsonOk({ ok: false }); }

  const { data: lead } = await supabase.from("leads").select("*").eq("id", leadId).maybeSingle();
  if (!lead) { await markFailed(supabase, body.job_id, "lead missing"); return jsonOk({ ok: false }); }

  // 1) Dedup against existing leads in same county
  const { data: existing } = await supabase
    .from("leads")
    .select("id, property_address, parcel_number, owner_name, sale_date")
    .eq("county_id", lead.county_id)
    .neq("id", leadId);

  const matchedId = (existing ?? []).find((e: any) => {
    if (lead.parcel_number && norm(e.parcel_number) === norm(lead.parcel_number)) return true;
    if (lead.property_address && lead.sale_date &&
        norm(e.property_address) === norm(lead.property_address) &&
        e.sale_date === lead.sale_date) return true;
    if (lead.owner_name && lead.sale_date && lead.county_id &&
        norm(e.owner_name) === norm(lead.owner_name) &&
        e.sale_date === lead.sale_date) return true;
    return false;
  })?.id;

  if (matchedId) {
    // Merge fresh fields into the existing lead, then drop this dup
    await supabase.from("leads").update({
      source_record_url: lead.source_record_url,
      sale_price: lead.sale_price,
      sale_date: lead.sale_date,
      deed_date: lead.deed_date,
      data_sources: lead.data_sources,
      updated_at: new Date().toISOString(),
    }).eq("id", matchedId);
    await supabase.from("leads").delete().eq("id", leadId);
    await supabase.from("lead_activities").insert({
      lead_id: matchedId,
      kind: "dedup_merged",
      summary: `Merged duplicate from ${lead.county}, ${lead.state}`,
    });
    // Re-qualify the merged lead
    await supabase.from("pipeline_jobs").insert({
      kind: "qualify_lead", lead_id: matchedId, priority: 90,
    });
    await supabase.from("pipeline_jobs").update({
      status: "done", finished_at: new Date().toISOString(),
      result: { merged_into: matchedId },
    }).eq("id", body.job_id);
    return jsonOk({ ok: true, merged_into: matchedId });
  }

  // 2) Smarty address resolution (best-effort, populates smarty_key + cleaner address)
  let smartyKey: string | null = lead.smarty_key ?? null;
  let resolvedAddress = lead.property_address;
  let resolvedCity = lead.property_city;
  let resolvedZip = lead.property_zip;
  if (smartyId && smartyToken && lead.property_address) {
    const rec = await smartyByAddress(
      lead.property_address, lead.property_city, lead.state, lead.property_zip,
      smartyId, smartyToken,
    );
    if (rec) {
      smartyKey = rec.smarty_key ?? smartyKey;
      const m = rec.matched_address ?? {};
      resolvedAddress = m.street ?? resolvedAddress;
      resolvedCity = m.city ?? resolvedCity;
      resolvedZip = m.zipcode ?? resolvedZip;
    }
  }

  const hasResolvedAddress = !!resolvedAddress;
  const newStage = hasResolvedAddress ? "verified" : "needs_review";

  await supabase.from("leads").update({
    smarty_key: smartyKey,
    property_address: resolvedAddress,
    property_city: resolvedCity,
    property_zip: resolvedZip,
    pipeline_stage: newStage,
    updated_at: new Date().toISOString(),
  }).eq("id", leadId);

  await supabase.from("lead_activities").insert({
    lead_id: leadId,
    kind: "verified",
    summary: hasResolvedAddress
      ? `Address verified${smartyKey ? " via Smarty" : ""}`
      : "Address could not be resolved — moved to needs_review",
    payload: { smarty_key: smartyKey },
  });

  if (hasResolvedAddress) {
    await supabase.from("pipeline_jobs").insert({
      kind: "qualify_lead", lead_id: leadId, priority: 90,
    });
  }

  await supabase.from("pipeline_jobs").update({
    status: "done", finished_at: new Date().toISOString(),
    result: { stage: newStage, smarty_key: smartyKey },
  }).eq("id", body.job_id);

  if (hasResolvedAddress) {
    supabase.functions.invoke("job-dispatcher", { body: { trigger: "verify_property_followups" } }).catch(() => {});
  }

  return jsonOk({ ok: true, stage: newStage });
});

function jsonOk(b: unknown) {
  return new Response(JSON.stringify(b), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function jsonErr(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
async function markFailed(supabase: any, jobId: string, msg: string) {
  await supabase.from("pipeline_jobs").update({
    status: "failed", finished_at: new Date().toISOString(), last_error: msg,
  }).eq("id", jobId);
}
