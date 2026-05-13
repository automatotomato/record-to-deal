// Seller Discovery agent — dedicated multi-pass contact hunt for one lead.
// Passes:
//   1. Entity unmask (OpenCorporates + state SoS via Firecrawl)
//   2. Person identity (LinkedIn / RocketReach / ZoomInfo / Bizapedia / Crunchbase)
//   3. Company website discovery
//   4. Apollo.io people/match + organization people search
//   5. Personal contact scrape (regex + scoring)
//   6. AI consolidation (OpenAI picks best per field with confidence)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FC_V2 = "https://api.firecrawl.dev/v2";
const APOLLO = "https://api.apollo.io/api/v1";
const AI_URL = "https://api.openai.com/v1/chat/completions";
const AI_MODEL = "gpt-4o-mini";

// Per-call budget so a single lead can't burn the day's quota
const BUDGET = { firecrawl: 12, apollo: 5, openai: 1 };

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia",
};

interface Discovery {
  name: string | null;
  role: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  company_website: string | null;
  entity_registry_url: string | null;
  related_entities: Array<{ name: string; url?: string }>;
  confidence_by_field: Record<string, { score: number; source: string }>;
  sources: string[];
  passes: Record<string, boolean>;
  notes: string[];
}

const empty = (): Discovery => ({
  name: null, role: null, email: null, phone: null, linkedin: null,
  company_website: null, entity_registry_url: null, related_entities: [],
  confidence_by_field: {}, sources: [], passes: {}, notes: [],
});

function setField(d: Discovery, field: keyof Discovery, value: any, score: number, source: string) {
  if (!value) return;
  const cur = d.confidence_by_field[field as string];
  if (!cur || score > cur.score) {
    (d as any)[field] = value;
    d.confidence_by_field[field as string] = { score, source };
  }
}

class Budget {
  constructor(public fc = 0, public apollo = 0, public ai = 0) {}
  canFc() { return this.fc < BUDGET.firecrawl; }
  canApollo() { return this.apollo < BUDGET.apollo; }
  canAi() { return this.ai < BUDGET.openai; }
}

async function fcSearch(query: string, key: string, limit: number, scrape: boolean, budget: Budget) {
  if (!budget.canFc()) return [];
  budget.fc++;
  try {
    const r = await fetch(`${FC_V2}/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query, limit,
        scrapeOptions: scrape ? { formats: ["markdown"], onlyMainContent: true } : undefined,
      }),
    });
    if (!r.ok) {
      console.warn(`fc ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return [];
    }
    const d = await r.json();
    const arr = d?.data ?? d?.web ?? [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { console.warn("fc threw", e); return []; }
}

async function fcScrape(url: string, key: string, budget: Budget): Promise<string | null> {
  if (!budget.canFc()) return null;
  budget.fc++;
  try {
    const r = await fetch(`${FC_V2}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.data?.markdown ?? d?.markdown ?? null;
  } catch (_) { return null; }
}

const APOLLO_HEADERS = (key: string) => ({
  "X-Api-Key": key,
  "Content-Type": "application/json",
  "Accept": "application/json",
  "Cache-Control": "no-cache",
});

function isUnlockedEmail(e?: string | null): boolean {
  if (!e) return false;
  return !/email_not_unlocked|domain\.com$/i.test(e);
}

// People match: best when we have first+last+domain. Returns single person.
async function apolloMatch(
  domain: string, first: string, last: string, key: string, budget: Budget,
) {
  if (!budget.canApollo()) return null;
  budget.apollo++;
  try {
    const r = await fetch(`${APOLLO}/people/match`, {
      method: "POST",
      headers: APOLLO_HEADERS(key),
      body: JSON.stringify({
        first_name: first,
        last_name: last,
        domain,
        // Spend a credit to actually unlock the email — without this Apollo
        // returns "email_not_unlocked@domain.com" and we drop it downstream.
        reveal_personal_emails: true,
      }),
    });
    if (!r.ok) {
      console.warn(`apollo match ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return null;
    }
    return await r.json();
  } catch (e) { console.warn("apollo match threw", e); return null; }
}

// Org-wide search by domain — pulls decision-maker titles.
async function apolloOrgPeople(domain: string, key: string, budget: Budget) {
  if (!budget.canApollo()) return null;
  budget.apollo++;
  try {
    const r = await fetch(`${APOLLO}/mixed_people/search`, {
      method: "POST",
      headers: APOLLO_HEADERS(key),
      body: JSON.stringify({
        q_organization_domains_list: [domain],
        person_titles: [
          "owner", "principal", "managing member", "manager",
          "president", "ceo", "founder", "partner", "director",
        ],
        page: 1,
        per_page: 10,
      }),
    });
    if (!r.ok) {
      console.warn(`apollo search ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return null;
    }
    return await r.json();
  } catch (e) { console.warn("apollo search threw", e); return null; }
}

function pickHostFromUrl(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return null; }
}

const SOCIAL_RE = /(linkedin|facebook|twitter|x\.com|instagram|youtube|google|maps|wikipedia|opencorporates|secretary|sos\.|gov$|bizapedia|zoominfo|rocketreach|crunchbase|signalhire|apollo|yelp|bbb\.org|yellowpages)/i;

function pickDomainFromText(text: string, ownerName: string | null): string | null {
  const slug = (ownerName ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  // Markdown links + bare urls
  const urls = Array.from(text.matchAll(/https?:\/\/[^\s)\]"'<>]+/g)).map((m) => m[0]);
  for (const u of urls) {
    const h = pickHostFromUrl(u);
    if (!h) continue;
    if (SOCIAL_RE.test(h)) continue;
    const compact = h.replace(/[^a-z0-9]/g, "");
    if (slug && slug.length >= 4 && compact.includes(slug.slice(0, Math.min(8, slug.length)))) return h;
  }
  // No match by name — return first non-social host as a weak guess
  for (const u of urls) {
    const h = pickHostFromUrl(u);
    if (h && !SOCIAL_RE.test(h)) return h;
  }
  return null;
}

function splitName(full: string | null): { first: string; last: string } | null {
  if (!full) return null;
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts[0], last: parts[parts.length - 1] };
}

function isEntity(ownerType: string | null, ownerName: string | null): boolean {
  if (ownerType && ownerType !== "Individual") return true;
  return !!ownerName && /\b(LLC|INC|CORP|TRUST|COMPANY|CO\.|LP|LLP|HOLDINGS|PARTNERS|PROPERTIES|GROUP)\b/i.test(ownerName);
}

function scoreEmail(email: string, name: string | null): number {
  const e = email.toLowerCase();
  if (/(noreply|no-reply|donotreply|postmaster|abuse|webmaster|spam)@/.test(e)) return 0;
  let s = 30;
  if (/(info|contact|hello|sales|admin|office)@/.test(e)) s = 25;
  if (name) {
    const slug = name.toLowerCase().replace(/[^a-z]+/g, "");
    const local = e.split("@")[0].replace(/[^a-z]+/g, "");
    const first = name.split(/\s+/)[0]?.toLowerCase() ?? "";
    const last = name.split(/\s+/).slice(-1)[0]?.toLowerCase() ?? "";
    if (slug && local.includes(slug.slice(0, 5))) s = 70;
    else if (local.includes(first) || local.includes(last)) s = 60;
  }
  return s;
}

function pullEmails(text: string): string[] {
  return Array.from(new Set((text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [])
    .map((e) => e.toLowerCase())));
}
function pullPhones(text: string): string[] {
  return Array.from(new Set((text.match(/\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) ?? [])
    .map((p) => p.trim())));
}

async function aiConsolidate(blob: string, openaiKey: string, budget: Budget): Promise<any> {
  if (!budget.canAi()) return null;
  budget.ai++;
  try {
    const r = await fetch(AI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: "system", content: "You consolidate scraped contact-info evidence about a single real-estate seller. Use null when uncertain — never invent. Return ONLY valid JSON." },
          { role: "user", content: `From the evidence below, identify the PRIMARY decision-maker behind this real-estate owner. Return JSON shaped exactly:
{
  "name": string|null,
  "role": string|null,
  "email": string|null,
  "phone": string|null,
  "linkedin": string|null,
  "company_website": string|null,
  "confidence": { "name": 0-100, "role": 0-100, "email": 0-100, "phone": 0-100, "linkedin": 0-100, "company_website": 0-100 },
  "reasoning": "one short sentence"
}

Evidence:
${blob.slice(0, 14000)}` },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return JSON.parse(d?.choices?.[0]?.message?.content ?? "{}");
  } catch (_) { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const fcKey = Deno.env.get("FIRECRAWL_API_KEY");
  const apolloKey = Deno.env.get("APOLLO_API_KEY");
  const openaiKey = Deno.env.get("OPENAI_API_KEY");

  if (!fcKey || !openaiKey) {
    return new Response(JSON.stringify({ error: "FIRECRAWL_API_KEY and OPENAI_API_KEY are required" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: { lead_id?: string; force?: boolean; company_website?: string } = {};
  try { body = await req.json(); } catch (_) {}
  const leadId = body.lead_id;
  if (!leadId) {
    return new Response(JSON.stringify({ error: "lead_id required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: lead, error: leadErr } = await supabase.from("leads").select("*").eq("id", leadId).single();
  if (leadErr || !lead) {
    return new Response(JSON.stringify({ error: leadErr?.message ?? "lead not found" }), {
      status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Cache: skip if reachable and not forced and no new website hint
  if (!body.force && !body.company_website && lead.discovery_status === "reachable") {
    return new Response(JSON.stringify({ ok: true, cached: true, status: lead.discovery_status }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const budget = new Budget();
  const d = empty();
  const ownerName: string | null = lead.owner_name ?? null;
  const ownerType: string | null = lead.owner_type ?? null;
  const state: string | null = lead.state ?? null;
  const city: string | null = lead.property_city ?? null;
  const stateName = state ? (STATE_NAMES[state] ?? state) : "";
  const entity = isEntity(ownerType, ownerName);

  // Pre-seed existing data so we never regress
  if (lead.decision_maker_name) setField(d, "name", lead.decision_maker_name, 30, "cached");
  if (lead.decision_maker_role) setField(d, "role", lead.decision_maker_role, 30, "cached");
  if (lead.decision_maker_email) setField(d, "email", lead.decision_maker_email, 40, "cached");
  if (lead.decision_maker_phone) setField(d, "phone", lead.decision_maker_phone, 30, "cached");
  if (lead.decision_maker_linkedin) setField(d, "linkedin", lead.decision_maker_linkedin, 35, "cached");
  if (lead.company_website) setField(d, "company_website", lead.company_website, 30, "cached");
  if (lead.entity_registry_url) d.entity_registry_url = lead.entity_registry_url;

  const evidence: string[] = [];

  // ============ PASS 1 — Entity unmask ============
  if (entity && ownerName) {
    d.passes.entity_unmask = true;
    const queries = [
      `"${ownerName}" site:opencorporates.com`,
      `"${ownerName}" ${stateName} secretary of state`,
      `"${ownerName}" site:bizapedia.com`,
    ];
    for (const q of queries) {
      const res = await fcSearch(q, fcKey, 3, true, budget);
      for (const r of res) {
        const md = `${r.url ?? ""}\n${r.title ?? ""}\n${r.markdown ?? r.description ?? ""}`;
        evidence.push(md);
        if (r.url && /opencorporates\.com/.test(r.url) && !d.entity_registry_url) {
          d.entity_registry_url = r.url;
          d.sources.push("opencorporates.com");
        }
        // Officer regex
        const m = md.match(/(?:Manager|Managing Member|President|CEO|Officer|Member|Director|Registered Agent)[\s:-]+([A-Z][a-zA-Z'-]+\s+[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)/);
        if (m) {
          const role = m[0].split(/[\s:-]+/)[0];
          setField(d, "name", m[1], 55, "sos");
          setField(d, "role", role, 55, "sos");
        }
        // Related entities (other LLCs near this name)
        const rel = Array.from(md.matchAll(/([A-Z][A-Za-z0-9& ]{2,}?\s+(?:LLC|INC|CORP|LP|LLP|HOLDINGS|PARTNERS))/g))
          .map((mm) => mm[1])
          .filter((n) => n.toUpperCase() !== (ownerName ?? "").toUpperCase())
          .slice(0, 5);
        for (const r2 of rel) {
          if (!d.related_entities.find((e) => e.name === r2)) d.related_entities.push({ name: r2, url: r.url });
        }
      }
      if (d.name) break;
    }
  } else if (ownerName) {
    setField(d, "name", ownerName, 50, "deed");
    setField(d, "role", "Owner", 50, "deed");
  }

  const targetName = d.name ?? ownerName;

  // ============ PASS 2 — Person identity (LinkedIn + people-search) ============
  if (targetName) {
    d.passes.person_identity = true;
    const queries = [
      `"${targetName}" ${city ?? ""} ${stateName} site:linkedin.com/in`,
      `"${targetName}" ${stateName} site:rocketreach.co OR site:zoominfo.com OR site:signalhire.com`,
      `"${targetName}" ${city ?? ""} real estate investor`,
    ];
    for (const q of queries) {
      const res = await fcSearch(q, fcKey, 4, false, budget);
      for (const r of res) {
        const u: string = r.url ?? "";
        if (/linkedin\.com\/in\//.test(u)) {
          // City match in title boosts confidence
          const titleMatch = (r.title ?? "").toLowerCase().includes((city ?? "").toLowerCase());
          setField(d, "linkedin", u, titleMatch ? 75 : 55, "linkedin");
          d.sources.push("linkedin.com");
        }
        evidence.push(`${u}\n${r.title ?? ""}\n${r.description ?? ""}`);
      }
      if (d.linkedin) break;
    }
  }

  // ============ PASS 3 — Company website discovery ============
  let domain: string | null = body.company_website
    ? pickHostFromUrl(body.company_website.startsWith("http") ? body.company_website : `https://${body.company_website}`)
    : (lead.company_website ?? null);

  if (!domain && entity && ownerName) {
    d.passes.website_discovery = true;
    const res = await fcSearch(`"${ownerName}" official site OR website`, fcKey, 4, false, budget);
    const blob = res.map((r: any) => `${r.url}\n${r.title ?? ""}\n${r.description ?? ""}`).join("\n");
    domain = pickDomainFromText(blob, ownerName);
    if (domain) {
      setField(d, "company_website", domain, 55, "search");
      d.sources.push(domain);
    }
  } else if (domain) {
    setField(d, "company_website", domain, body.company_website ? 90 : 60, body.company_website ? "user" : "cached");
  }

  // Confirm/scrape homepage + contact page
  if (domain) {
    const homeMd = await fcScrape(`https://${domain}`, fcKey, budget);
    if (homeMd) evidence.push(`HOMEPAGE ${domain}\n${homeMd.slice(0, 4000)}`);
    const contactMd = await fcScrape(`https://${domain}/contact`, fcKey, budget);
    if (contactMd) evidence.push(`CONTACT ${domain}\n${contactMd.slice(0, 4000)}`);
  }

  // ============ PASS 4 — Apollo.io ============
  if (apolloKey && domain) {
    d.passes.apollo = true;
    // People match first if we have a name
    const split = splitName(targetName);
    if (split) {
      const matched = await apolloMatch(domain, split.first, split.last, apolloKey, budget);
      const p = matched?.person ?? matched?.matched_person ?? null;
      if (p) {
        if (isUnlockedEmail(p.email)) {
          setField(d, "email", p.email, 90, "apollo.match");
        }
        if (!d.role && p.title) setField(d, "role", p.title, 65, "apollo");
        if (!d.linkedin && p.linkedin_url) setField(d, "linkedin", p.linkedin_url, 70, "apollo");
        const phoneList = p.phone_numbers ?? [];
        const ph = Array.isArray(phoneList) ? phoneList[0]?.sanitized_number ?? phoneList[0]?.raw_number : null;
        if (!d.phone && ph) setField(d, "phone", ph, 70, "apollo");
        d.sources.push("apollo.io");
      }
    }
    // Org-wide search as broader fallback to find any decision-maker
    if (!d.email) {
      const search = await apolloOrgPeople(domain, apolloKey, budget);
      const people: any[] = search?.people ?? [];
      const ranked = [...people].sort((a, b) => {
        const w = (e: any) => (/owner|principal|manager|president|ceo|founder|partner/i.test(`${e.title ?? ""} ${e.seniority ?? ""}`) ? 1 : 0);
        return w(b) - w(a);
      });
      // Prefer someone we can actually unlock (has first+last name)
      const pick = ranked.find((x) => x.first_name && x.last_name) ?? ranked[0];
      if (pick) {
        // Org search returns locked emails. Run a /people/match with reveal=true
        // to actually unlock the address.
        let unlockedEmail: string | null = null;
        if (pick.first_name && pick.last_name) {
          const matched = await apolloMatch(domain, pick.first_name, pick.last_name, apolloKey, budget);
          const mp = matched?.person ?? matched?.matched_person ?? null;
          if (mp && isUnlockedEmail(mp.email)) unlockedEmail = mp.email;
          if (mp?.phone_numbers?.[0]) {
            const ph = mp.phone_numbers[0]?.sanitized_number ?? mp.phone_numbers[0]?.raw_number;
            if (!d.phone && ph) setField(d, "phone", ph, 70, "apollo.match");
          }
        }
        if (unlockedEmail) {
          setField(d, "email", unlockedEmail, 85, "apollo.match");
        } else if (isUnlockedEmail(pick.email)) {
          setField(d, "email", pick.email, 80, "apollo.search");
        }
        if (!d.name && (pick.first_name || pick.last_name)) {
          setField(d, "name", `${pick.first_name ?? ""} ${pick.last_name ?? ""}`.trim(), 65, "apollo");
        }
        if (!d.role && pick.title) setField(d, "role", pick.title, 60, "apollo");
        if (!d.linkedin && pick.linkedin_url) setField(d, "linkedin", pick.linkedin_url, 65, "apollo");
        d.sources.push("apollo.io");
      }
    }
  }

  // ============ PASS 5 — Personal contact scrape (regex + scoring) ============
  if (!d.email || !d.phone) {
    d.passes.scrape = true;
    if (targetName) {
      const res = await fcSearch(`"${targetName}" ${city ?? ""} contact email phone`, fcKey, 3, true, budget);
      for (const r of res) {
        const md = `${r.url ?? ""}\n${r.markdown ?? ""}`;
        evidence.push(md.slice(0, 4000));
      }
    }
    const allEvidence = evidence.join("\n---\n");
    if (!d.email) {
      const emails = pullEmails(allEvidence);
      let best: { e: string; s: number } | null = null;
      for (const e of emails) {
        const s = scoreEmail(e, targetName);
        if (s > 0 && (!best || s > best.s)) best = { e, s };
      }
      if (best) setField(d, "email", best.e, best.s, "scrape");
    }
    if (!d.phone) {
      const phones = pullPhones(allEvidence);
      if (phones.length) setField(d, "phone", phones[0], 35, "scrape");
    }
  }

  // ============ PASS 6 — AI consolidation ============
  if (evidence.length && (!d.email || !d.linkedin || !d.name)) {
    d.passes.ai_consolidate = true;
    const blob = evidence.join("\n---\n");
    const ai = await aiConsolidate(blob, openaiKey, budget);
    if (ai && typeof ai === "object") {
      const c = ai.confidence ?? {};
      if (ai.name) setField(d, "name", ai.name, c.name ?? 50, "ai");
      if (ai.role) setField(d, "role", ai.role, c.role ?? 50, "ai");
      if (ai.email) setField(d, "email", ai.email, c.email ?? 45, "ai");
      if (ai.phone) setField(d, "phone", ai.phone, c.phone ?? 35, "ai");
      if (ai.linkedin) setField(d, "linkedin", ai.linkedin, c.linkedin ?? 50, "ai");
      if (ai.company_website) {
        const h = pickHostFromUrl(ai.company_website.startsWith("http") ? ai.company_website : `https://${ai.company_website}`);
        if (h) setField(d, "company_website", h, c.company_website ?? 50, "ai");
      }
      if (ai.reasoning) d.notes.push(ai.reasoning);
      d.sources.push("openai");
    }
  }

  // ============ Determine status ============
  let status: "none" | "partial" | "reachable" | "failed" = "none";
  if (d.email) status = "reachable";
  else if (d.phone || d.linkedin) status = "partial";
  else status = "failed";

  // Compute completeness (0-100)
  let completeness = 0;
  if (lead.mailing_address) completeness += 30;
  if (d.name) completeness += 15;
  if (d.email) completeness += 30;
  if (d.phone) completeness += 15;
  if (d.linkedin) completeness += 10;

  // Persist
  const updates: Record<string, unknown> = {
    decision_maker_name: d.name,
    decision_maker_role: d.role,
    decision_maker_email: d.email,
    decision_maker_phone: d.phone,
    decision_maker_linkedin: d.linkedin,
    contact_email: d.email ?? lead.contact_email,
    contact_phone: d.phone ?? lead.contact_phone,
    contact_linkedin: d.linkedin ?? lead.contact_linkedin,
    company_website: d.company_website,
    entity_registry_url: d.entity_registry_url ?? lead.entity_registry_url,
    related_entities: d.related_entities,
    discovery_confidence_by_field: d.confidence_by_field,
    discovery_status: status,
    enrichment_confidence: Math.max(
      lead.enrichment_confidence ?? 0,
      Math.round(Object.values(d.confidence_by_field).reduce((a: number, v: any) => a + v.score, 0) / Math.max(1, Object.keys(d.confidence_by_field).length)),
    ),
    contact_completeness: Math.max(lead.contact_completeness ?? 0, completeness),
    enrichment_payload: { ...(lead.enrichment_payload ?? {}), discovery_v2: { ...d, budget_used: budget } },
    data_sources: Array.from(new Set([...(lead.data_sources ?? []), ...d.sources])),
  };

  // If draft email exists with no recipient, update it
  if (d.email) {
    await supabase.from("outreach_emails")
      .update({ to_email: d.email })
      .eq("lead_id", leadId)
      .eq("status", "draft")
      .is("to_email", null);
  }

  const { error: updErr } = await supabase.from("leads").update(updates).eq("id", leadId);
  if (updErr) {
    return new Response(JSON.stringify({ error: updErr.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  await supabase.from("lead_activities").insert({
    lead_id: leadId,
    kind: "seller_discovery",
    summary: `Discovery: ${status}${d.email ? ` · email ✓` : ""}${d.phone ? " · phone ✓" : ""}${d.linkedin ? " · LinkedIn ✓" : ""} · used ${budget.fc} FC + ${budget.apollo} Apollo + ${budget.ai} AI`,
    payload: { discovery: d, budget_used: budget },
  });

  return new Response(JSON.stringify({ ok: true, status, discovery: d, budget_used: budget }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
