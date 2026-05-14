// enrich-contact worker: takes a QUALIFIED lead, runs Apollo + Firecrawl
// to find decision-maker contact info. Updates contact fields, recomputes
// has_contact / has_outreach_contact, advances pipeline_stage to enriched.
// On has_outreach_contact=true, enqueues draft_outreach. Job kind: enrich_contact.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FIRECRAWL_V2 = "https://api.firecrawl.dev/v2";

const norm = (s: string | null | undefined) =>
  (s ?? "").toString().trim().toUpperCase().replace(/\s+/g, " ").replace(/[.,]/g, "");

function isUnlockedEmail(e?: string | null): boolean {
  if (!e) return false;
  if (!/[^@\s]+@[^@\s]+\.[a-z]{2,}/i.test(e)) return false;
  return !/email_not_unlocked|domain\.com$|@apollo-locked/i.test(e);
}

async function fcSearch(query: string, key: string, limit = 3, scrape = true) {
  try {
    const resp = await fetch(`${FIRECRAWL_V2}/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query, limit,
        scrapeOptions: scrape ? { formats: ["markdown"] } : undefined,
      }),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const arr = data?.data?.web ?? data?.data ?? [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function apolloSearch(domain: string, key: string) {
  try {
    const r = await fetch("https://api.apollo.io/api/v1/mixed_people/search", {
      method: "POST",
      headers: { "X-Api-Key": key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        q_organization_domains_list: [domain],
        person_titles: ["owner", "principal", "managing member", "manager", "president", "ceo", "founder", "partner", "director"],
        page: 1, per_page: 10,
      }),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Apollo search returns locked email placeholders. /people/match with
// reveal_personal_emails:true actually unlocks the address (1 credit).
// Domain, organization, location, and linkedin_url are all optional hints —
// pass whatever we have to maximize match rate.
async function apolloReveal(
  opts: {
    first?: string | null; last?: string | null;
    name?: string | null;
    domain?: string | null;
    organizationName?: string | null;
    linkedinUrl?: string | null;
    city?: string | null; state?: string | null;
  },
  key: string,
) {
  const body: Record<string, unknown> = {
    reveal_personal_emails: true,
    // reveal_phone_number requires an async webhook_url on Apollo — omitted here.
  };
  if (opts.first) body.first_name = opts.first;
  if (opts.last) body.last_name = opts.last;
  if (opts.name && !opts.first && !opts.last) body.name = opts.name;
  if (opts.domain) body.domain = opts.domain;
  if (opts.organizationName) body.organization_name = opts.organizationName;
  if (opts.linkedinUrl) body.linkedin_url = opts.linkedinUrl;
  if (opts.city) body.city = opts.city;
  if (opts.state) body.state = opts.state;

  try {
    const r = await fetch("https://api.apollo.io/api/v1/people/match", {
      method: "POST",
      headers: { "X-Api-Key": key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data?.person ?? data?.matched_person ?? null;
  } catch { return null; }
}

function splitName(full: string): { first: string; last: string } {
  const cleaned = full.replace(/,?\s*(jr|sr|ii|iii|iv|esq)\.?$/i, "").trim();
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

function nameFromLinkedIn(url: string): { first: string; last: string } | null {
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return null;
  const slug = decodeURIComponent(m[1]).split("-").filter((p) => !/^\d+$/.test(p) && p.length > 1);
  if (slug.length < 2) return null;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return { first: cap(slug[0]), last: slug.slice(1).map(cap).join(" ") };
}

function applyRevealed(
  revealed: any,
  cur: { dmEmail: string | null; dmPhone: string | null; dmName: string | null; dmRole: string | null; dmLinkedIn: string | null },
) {
  const email = isUnlockedEmail(revealed?.email) ? revealed.email
    : (revealed?.personal_emails ?? []).find((e: string) => isUnlockedEmail(e)) ?? null;
  const phone = revealed?.phone_numbers?.[0]?.sanitized_number
    ?? revealed?.phone_numbers?.[0]?.raw_number
    ?? revealed?.mobile_phone ?? null;
  let bumped = 0;
  if (email && !isUnlockedEmail(cur.dmEmail)) { cur.dmEmail = email; bumped += 25; }
  if (phone && !cur.dmPhone) { cur.dmPhone = phone; bumped += 15; }
  if (!cur.dmName && (revealed?.first_name || revealed?.last_name)) {
    cur.dmName = `${revealed.first_name ?? ""} ${revealed.last_name ?? ""}`.trim();
  }
  if (!cur.dmRole && revealed?.title) cur.dmRole = revealed.title;
  if (!cur.dmLinkedIn && revealed?.linkedin_url) cur.dmLinkedIn = revealed.linkedin_url;
  return bumped;
}

function pickDomain(html: string, ownerName: string | null): string | null {
  const links = Array.from(html.matchAll(/href="(https?:\/\/[^"]+)"/g)).map((m) => m[1]);
  const slug = (ownerName ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (const url of links) {
    try {
      const h = new URL(url).hostname.replace(/^www\./, "");
      if (/(linkedin|facebook|twitter|instagram|google|maps|youtube|wikipedia|opencorporates|secretary)/i.test(h)) continue;
      if (slug && h.replace(/[^a-z0-9]/g, "").includes(slug.slice(0, 6))) return h;
    } catch { /* ignore */ }
  }
  return null;
}

function isOutreachContact(l: any): boolean {
  const okEmail = isUnlockedEmail(l.decision_maker_email);
  const okPhone = (l.decision_maker_phone || l.contact_phone) && String(l.decision_maker_phone || l.contact_phone).replace(/\D/g, "").length >= 10;
  const okWeb = l.company_website && /^https?:\/\//i.test(l.company_website);
  const okLi = l.decision_maker_linkedin || l.contact_linkedin;
  return !!(okEmail || okPhone || okWeb || okLi);
}

function isAnyContact(l: any): boolean {
  if (isOutreachContact(l)) return true;
  if (l.mailing_address && norm(l.mailing_address) !== norm(l.property_address)) return true;
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");
  const apolloKey = Deno.env.get("APOLLO_API_KEY");

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
  let dmEmail: string | null = lead.decision_maker_email ?? null;
  let dmPhone: string | null = lead.decision_maker_phone ?? null;
  let dmLinkedIn: string | null = lead.decision_maker_linkedin ?? null;
  let companySite: string | null = lead.company_website ?? null;
  const sources: string[] = [...(lead.data_sources ?? [])];
  let confidence = lead.enrichment_confidence ?? 0;

  // For individuals, the owner IS the decision-maker
  if (!isEntity && ownerName && !dmName) {
    dmName = ownerName; dmRole = "Owner";
  }

  // 1) LinkedIn search via Firecrawl
  if (firecrawlKey && (dmName || ownerName)) {
    const target = dmName ?? ownerName!;
    const liRes = await fcSearch(
      `"${target}" ${lead.property_city ?? ""} ${lead.state ?? ""} site:linkedin.com/in`,
      firecrawlKey, 2, false,
    );
    const liUrl = liRes.find((r: any) => /linkedin\.com\/in\//.test(r.url ?? ""))?.url;
    if (liUrl && !dmLinkedIn) { dmLinkedIn = liUrl; confidence += 10; sources.push("firecrawl:linkedin"); }
  }

  const cur = { dmEmail, dmPhone, dmName, dmRole, dmLinkedIn };

  // 2) Apollo via guessed domain (entities only)
  if (apolloKey && firecrawlKey && isEntity && ownerName && !isUnlockedEmail(cur.dmEmail)) {
    const probe = await fcSearch(`"${ownerName}" website OR contact`, firecrawlKey, 2, true);
    const blob = probe.map((r: any) => `${r.url}\n${r.markdown ?? ""}`).join("\n");
    const domain = pickDomain(blob, ownerName);
    if (domain) {
      companySite = companySite ?? `https://${domain}`;
      const apollo = await apolloSearch(domain, apolloKey);
      const people = apollo?.people as any[] | undefined;
      if (people?.length) {
        const ranked = [...people].sort((a, b) =>
          (/owner|principal|manager|president|ceo|founder|partner/i.test(`${b.title ?? ""} ${b.seniority ?? ""}`) ? 1 : 0) -
          (/owner|principal|manager|president|ceo|founder|partner/i.test(`${a.title ?? ""} ${a.seniority ?? ""}`) ? 1 : 0)
        );
        const pick = ranked.find((x) => x.first_name && x.last_name) ?? ranked[0];
        if (pick?.first_name && pick?.last_name) {
          const revealed = await apolloReveal({
            first: pick.first_name, last: pick.last_name, domain,
            organizationName: ownerName,
            city: lead.property_city, state: lead.state,
          }, apolloKey);
          if (revealed) confidence += applyRevealed(revealed, cur);
        }
        if (!cur.dmName && (pick.first_name || pick.last_name)) cur.dmName = `${pick.first_name ?? ""} ${pick.last_name ?? ""}`.trim();
        if (!cur.dmRole && pick.title) cur.dmRole = pick.title;
        if (!cur.dmLinkedIn && pick.linkedin_url) cur.dmLinkedIn = pick.linkedin_url;
        sources.push("apollo.io");
      }
    }
  }

  // 3) Apollo reveal by name — fallback for individuals OR entities where
  //    the domain probe failed. Apollo can match by name + location, or by
  //    linkedin_url alone (very high hit rate when LI is known).
  if (apolloKey && (!isUnlockedEmail(cur.dmEmail) || !cur.dmPhone)) {
    let first: string | null = null;
    let last: string | null = null;

    if (cur.dmName) {
      const s = splitName(cur.dmName);
      first = s.first; last = s.last;
    } else if (cur.dmLinkedIn) {
      const s = nameFromLinkedIn(cur.dmLinkedIn);
      if (s) { first = s.first; last = s.last; }
    } else if (!isEntity && ownerName) {
      const s = splitName(ownerName);
      first = s.first; last = s.last;
    }

    if ((first && last) || cur.dmLinkedIn) {
      const revealed = await apolloReveal({
        first, last,
        linkedinUrl: cur.dmLinkedIn,
        organizationName: isEntity ? ownerName : null,
        city: lead.property_city, state: lead.state,
      }, apolloKey);
      if (revealed) {
        const bumped = applyRevealed(revealed, cur);
        if (bumped > 0) sources.push("apollo.io:reveal");
      }
    }
  }

  dmEmail = cur.dmEmail; dmPhone = cur.dmPhone;
  dmName = cur.dmName; dmRole = cur.dmRole; dmLinkedIn = cur.dmLinkedIn;

  const updated = {
    decision_maker_name: dmName,
    decision_maker_role: dmRole,
    decision_maker_email: isUnlockedEmail(dmEmail) ? dmEmail : null,
    decision_maker_phone: dmPhone,
    decision_maker_linkedin: dmLinkedIn,
    contact_email: isUnlockedEmail(dmEmail) ? dmEmail : lead.contact_email,
    contact_phone: dmPhone ?? lead.contact_phone,
    contact_linkedin: dmLinkedIn ?? lead.contact_linkedin,
    company_website: companySite,
    enrichment_confidence: Math.min(100, confidence),
    data_sources: Array.from(new Set(sources)),
  };

  const merged = { ...lead, ...updated };
  const hasContact = isAnyContact(merged);
  const hasOutreach = isOutreachContact(merged);

  const newStage = hasOutreach ? "enriched" : hasContact ? "needs_review" : "needs_review";

  await supabase.from("leads").update({
    ...updated,
    has_contact: hasContact,
    has_outreach_contact: hasOutreach,
    pipeline_stage: newStage,
    updated_at: new Date().toISOString(),
  }).eq("id", leadId);

  await supabase.from("lead_activities").insert({
    lead_id: leadId,
    kind: "enriched",
    summary: hasOutreach
      ? `Decision-maker contact found${dmEmail ? " (email)" : dmPhone ? " (phone)" : dmLinkedIn ? " (LinkedIn)" : " (website)"}`
      : `No actionable contact path — moved to needs_review`,
    payload: updated,
  });

  if (hasOutreach) {
    await supabase.from("pipeline_jobs").insert({
      kind: "draft_outreach", lead_id: leadId,
      priority: lead.is_urgent ? 40 : 70,
    });
  } else {
    // No usable contact yet — kick the deeper Apollo+Firecrawl+AI hunt.
    await supabase.from("pipeline_jobs").insert({
      kind: "seller_discovery", lead_id: leadId,
      priority: lead.is_urgent ? 35 : 60,
    });
  }

  // Always queue an AI brief once we know what we have so the drawer is
  // immediately useful even if contact hunting is still in flight.
  await supabase.from("pipeline_jobs").insert({
    kind: "lead_brief", lead_id: leadId, priority: 80,
  });

  await supabase.from("pipeline_jobs").update({
    status: "done", finished_at: new Date().toISOString(),
    result: { stage: newStage, has_outreach_contact: hasOutreach },
  }).eq("id", body.job_id);

  return jsonOk({ ok: true, stage: newStage, has_outreach_contact: hasOutreach });
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
