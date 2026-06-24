// enrich-contact worker: lightweight first pass before the heavier
// seller-discovery agent. Uses Firecrawl to seed a LinkedIn URL when we
// can find one, then ALWAYS hands off to seller_discovery (Gemini-driven)
// for the actual contact hunt. Apollo has been removed.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { enqueueOnce } from "../_shared/enqueue.ts";
import { fcSearch, shouldSkipDiscovery, recordDiscoveryAttempt, parkAbandoned } from "../_shared/firecrawl.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const norm = (s: string | null | undefined) =>
  (s ?? "").toString().trim().toUpperCase().replace(/\s+/g, " ").replace(/[.,]/g, "");

function isUnlockedEmail(e?: string | null): boolean {
  if (!e) return false;
  if (!/[^@\s]+@[^@\s]+\.[a-z]{2,}/i.test(e)) return false;
  return !/email_not_unlocked|domain\.com$|@apollo-locked/i.test(e);
}

function isOutreachContact(l: any): boolean {
  const okEmail = isUnlockedEmail(l.decision_maker_email);
  const okPhone = (l.decision_maker_phone || l.contact_phone) && String(l.decision_maker_phone || l.contact_phone).replace(/\D/g, "").length >= 10;
  return !!(okEmail || okPhone);
}

function isAnyContact(l: any): boolean {
  if (isOutreachContact(l)) return true;
  if (l.company_website && /^https?:\/\//i.test(l.company_website)) return true;
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");

  let body: { job_id?: string } = {};
  try { body = await req.json(); } catch (_) {}
  if (!body.job_id) return jsonErr("job_id required", 400);

  const { data: job } = await supabase.from("pipeline_jobs").select("*").eq("id", body.job_id).maybeSingle();
  if (!job) return jsonErr("job not found", 404);
  const leadId = job.lead_id;
  if (!leadId) { await markFailed(supabase, body.job_id, "no lead_id"); return jsonOk({ ok: false }); }

  const { data: lead } = await supabase.from("leads").select("*").eq("id", leadId).maybeSingle();
  if (!lead) { await markFailed(supabase, body.job_id, "lead missing"); return jsonOk({ ok: false }); }

  if (lead.tier === "DISQUALIFIED" || lead.pipeline_stage === "disqualified") {
    await supabase.from("pipeline_jobs").update({
      status: "done", finished_at: new Date().toISOString(),
      result: { skipped: "disqualified" },
    }).eq("id", body.job_id);
    return jsonOk({ ok: true, skipped: "disqualified" });
  }

  const ownerName = lead.owner_name as string | null;
  const isEntity = lead.owner_type !== "Individual" && lead.owner_type !== "Unknown";
  let dmName: string | null = lead.decision_maker_name ?? null;
  let dmRole: string | null = lead.decision_maker_role ?? null;
  let dmLinkedIn: string | null = lead.decision_maker_linkedin ?? null;
  const sources: string[] = [...(lead.data_sources ?? [])];
  let confidence = lead.enrichment_confidence ?? 0;

  // For individuals, the owner IS the decision-maker
  if (!isEntity && ownerName && !dmName) {
    dmName = ownerName; dmRole = "Owner";
  }

  // Single lightweight pass: try to find a LinkedIn URL via Firecrawl. The
  // heavy lifting (Gemini grounded search, scraping, consolidation) happens
  // in seller-discovery which we always queue below.
  if (firecrawlKey && (dmName || ownerName)) {
    const target = dmName ?? ownerName!;
    const liRes = await fcSearch(
      `"${target}" ${lead.property_city ?? ""} ${lead.state ?? ""} site:linkedin.com/in -realtor -broker -"real estate agent" -"listing agent"`,
      firecrawlKey, 2,
    );
    const liUrl = liRes.find((r: any) => {
      const u = r.url ?? "";
      if (!/linkedin\.com\/in\//.test(u)) return false;
      // Skip slugs that clearly belong to brokers/agents.
      const slug = u.toLowerCase();
      return !/-realtor|-broker|-real-?estate-?agent|-listing-?agent/.test(slug);
    })?.url;
    if (liUrl && !dmLinkedIn) {
      dmLinkedIn = liUrl;
      confidence += 10;
      sources.push("firecrawl:linkedin");
    }
  }

  const updated = {
    decision_maker_name: dmName,
    decision_maker_role: dmRole,
    decision_maker_linkedin: dmLinkedIn,
    contact_linkedin: dmLinkedIn ?? lead.contact_linkedin,
    enrichment_confidence: Math.min(100, confidence),
    data_sources: Array.from(new Set(sources)),
  };

  const merged = { ...lead, ...updated };
  const hasContact = isAnyContact(merged);
  const hasOutreach = isOutreachContact(merged);

  // Always route through seller_discovery — it's where the real contact
  // hunting lives. enrich-contact just primes name/LinkedIn metadata.
  await supabase.from("leads").update({
    ...updated,
    has_contact: hasContact,
    has_outreach_contact: hasOutreach,
    pipeline_stage: hasOutreach ? "enriched" : "needs_review",
    updated_at: new Date().toISOString(),
  }).eq("id", leadId);

  await supabase.from("lead_activities").insert({
    lead_id: leadId,
    kind: "enriched",
    summary: dmLinkedIn
      ? `Seeded LinkedIn — handing off to seller-discovery for contact hunt`
      : `No LinkedIn match — handing off to seller-discovery for contact hunt`,
    payload: updated,
  });

  // Only queue the deeper hunt when we still need contact info,
  // and only refresh the brief if we don't already have one (24h cooldown applies either way).
  await enqueueOnce(supabase, "seller_discovery", leadId, {
    priority: lead.is_urgent ? 35 : 60,
    cooldownHours: 24,
    unlessLeadHas: [{ column: "decision_maker_email", op: "not_null" }],
  });
  await enqueueOnce(supabase, "lead_brief", leadId, {
    priority: 80,
    cooldownHours: 24,
    unlessLeadHas: [{ column: "ai_brief", op: "not_null" }],
  });

  await supabase.from("pipeline_jobs").update({
    status: "done", finished_at: new Date().toISOString(),
    result: { handed_off: "seller_discovery", linkedin_seeded: !!dmLinkedIn },
  }).eq("id", body.job_id);

  return jsonOk({ ok: true, linkedin_seeded: !!dmLinkedIn });
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
