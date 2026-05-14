// Seller Discovery agent — dedicated multi-pass contact hunt for one lead.
// Passes (Apollo removed — Gemini grounded search + Firecrawl scraping only):
//   1. Entity unmask (OpenCorporates + state SoS via Firecrawl)
//   2. Person identity (LinkedIn / RocketReach / ZoomInfo / Bizapedia)
//   3. Company website discovery + homepage/contact scrape
//   4. Source record scrape (broker/listing pages)
//   5. Gemini grounded public-contact hunt (Google Search)
//   6. Personal contact scrape (regex + scoring)
//   7. AI consolidation (Gemini picks best per field with confidence)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FC_V2 = "https://api.firecrawl.dev/v2";
const AI_URL = "https://api.openai.com/v1/chat/completions";
const AI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-5.1";
if (!(globalThis as any).__sdLogged) { console.log(`[seller-discovery] OpenAI model: ${AI_MODEL}`); (globalThis as any).__sdLogged = true; }

// Per-call budget so a single lead can't burn the day's quota
const BUDGET = { firecrawl: 15, ai: 3 };

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
  constructor(public fc = 0, public ai = 0) {}
  canFc() { return this.fc < BUDGET.firecrawl; }
  canAi() { return this.ai < BUDGET.ai; }
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
    const arr = d?.data?.web ?? d?.data ?? d?.web ?? [];
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

const GATEWAY_HEADERS = (key: string) => ({
  "Authorization": `Bearer ${key}`,
  "Content-Type": "application/json",
});

function isUnlockedEmail(e?: string | null): boolean {
  if (!e) return false;
  if (!/[^@\s]+@[^@\s]+\.[a-z]{2,}/i.test(e)) return false;
  return !/email_not_unlocked|domain\.com$|@apollo-locked/i.test(e);
}

function pickHostFromUrl(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return null; }
}

const SOCIAL_RE = /(linkedin|facebook|twitter|x\.com|instagram|youtube|google|maps|wikipedia|opencorporates|secretary|sos\.|gov$|bizapedia|zoominfo|rocketreach|crunchbase|signalhire|apollo|yelp|bbb\.org|yellowpages|loopnet|crexi|redfin|zillow|realtor\.com|sec\.gov)/i;

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

function looksLikePersonName(name: string | null): boolean {
  if (!name) return false;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return false;
  return !/\b(LLC|INC|CORP|COMPANY|FRESH|BRANDS|HOLDINGS|ACQUISITION|PROPERTIES|GROUP|DOCUMENTS|FUNDING)\b/i.test(name);
}

function isKnownOwnerName(name: string | null): boolean {
  return !!name && !/^unknown$/i.test(name.trim()) && name.trim().length > 2;
}

function splitLinkedInName(url: string | null): { first: string; last: string } | null {
  if (!url) return null;
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return null;
  const parts = decodeURIComponent(m[1])
    .split("-")
    .filter((p) => p.length > 1 && !/^\d+$/.test(p) && !/^(realestate|realtor|broker|investor)$/i.test(p));
  if (parts.length < 2) return null;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  return { first: cap(parts[0]), last: parts.slice(1).map(cap).join(" ") };
}



function acceptScrapedEmail(email: string, score: number, name: string | null, domain: string | null): boolean {
  if (!isUnlockedEmail(email) || score <= 0) return false;
  if (domain && email.toLowerCase().endsWith(`@${domain.toLowerCase()}`)) return true;
  return score >= 60 && !!name;
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

function scorePhone(text: string, phone: string, targetName: string | null, ownerName: string | null, domain: string | null): number {
  let score = 25;
  const lower = text.toLowerCase();
  if (domain && lower.includes(domain.toLowerCase())) score += 20;
  if (targetName && lower.includes(targetName.toLowerCase())) score += 20;
  if (ownerName && lower.includes(ownerName.toLowerCase())) score += 15;
  const idx = lower.indexOf(phone.toLowerCase());
  const window = idx >= 0 ? lower.slice(Math.max(0, idx - 180), idx + 180) : lower;
  if (/owner|principal|broker|agent|leasing|sales|contact|mobile|direct|office/.test(window)) score += 20;
  return score;
}

function pullEmails(text: string): string[] {
  return Array.from(new Set((text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [])
    .map((e) => e.toLowerCase())));
}
function pullPhones(text: string): string[] {
  return Array.from(new Set((text.match(/\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) ?? [])
    .map((p) => p.trim())));
}

function normalizeWebsite(value: string | null | undefined): string | null {
  if (!value) return null;
  const host = pickHostFromUrl(value.startsWith("http") ? value : `https://${value}`);
  return host ? `https://${host}` : null;
}

function hasUsablePhone(...phones: Array<string | null | undefined>): boolean {
  return phones.some((p) => String(p ?? "").replace(/\D/g, "").length >= 10);
}

function isUsefulLead(l: { decision_maker_email?: string | null; decision_maker_phone?: string | null; contact_phone?: string | null; company_website?: string | null }) {
  return isUnlockedEmail(l.decision_maker_email) || hasUsablePhone(l.decision_maker_phone, l.contact_phone) || !!normalizeWebsite(l.company_website);
}

function parseJsonObject(raw: unknown): any {
  const text = String(raw ?? "{}").trim().replace(/^```json\s*|\s*```$/g, "");
  try { return JSON.parse(text); } catch (_) {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}

async function geminiPublicContactHunt(lead: any, targetName: string | null, entity: boolean, apiKey: string, fcKey: string, budget: Budget): Promise<any> {
  if (!budget.canAi()) return null;
  const owner = lead.owner_name ?? "unknown owner";
  const address = [lead.property_address, lead.property_city, lead.state].filter(Boolean).join(", ");

  // Step 1: gather REAL evidence via Firecrawl search (no fake "use Google Search").
  const queries = [
    targetName ? `"${targetName}" ${lead.property_city ?? ""} email contact` : null,
    targetName ? `"${targetName}" linkedin OR rocketreach` : null,
    `"${owner}" contact email phone`,
    entity ? `"${owner}" site:opencorporates.com OR site:bizapedia.com` : null,
  ].filter(Boolean) as string[];

  const evidence: string[] = [];
  for (const q of queries.slice(0, 3)) {
    const res = await fcSearch(q, fcKey, 4, true, budget);
    for (const r of res) {
      evidence.push(`URL: ${r.url ?? ""}\nTITLE: ${r.title ?? ""}\n${(r.markdown ?? r.description ?? "").slice(0, 3500)}`);
    }
    if (evidence.length >= 8) break;
  }
  if (!evidence.length) return null;

  budget.ai++;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(AI_URL, {
      method: "POST",
      headers: GATEWAY_HEADERS(apiKey),
      signal: ctrl.signal,
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: "system", content: "You extract decision-maker contact info from scraped web evidence. Use ONLY facts present in the evidence — never invent emails, phones, or names. Leave fields null when uncertain. Return ONLY valid JSON." },
          { role: "user", content: `Identify the decision-maker behind this real-estate seller using the evidence below.

Owner/entity: ${owner}
Known person (if any): ${targetName ?? "unknown"}
Owner type: ${entity ? "entity/company/trust" : "individual"}
Property: ${address || "unknown"}

EVIDENCE:
${evidence.join("\n---\n").slice(0, 18000)}

Return JSON exactly:
{
  "name": string|null,
  "role": string|null,
  "email": string|null,
  "phone": string|null,
  "linkedin": string|null,
  "company_website": string|null,
  "source_urls": string[],
  "confidence": { "name": 0-100, "role": 0-100, "email": 0-100, "phone": 0-100, "linkedin": 0-100, "company_website": 0-100 },
  "reasoning": "one short sentence"
}` },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!r.ok) {
      console.warn(`openai public hunt ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return null;
    }
    const data = await r.json();
    return parseJsonObject(data?.choices?.[0]?.message?.content);
  } catch (e) { console.warn("public hunt threw", e); return null; }
  finally { clearTimeout(tid); }
}

async function aiConsolidate(blob: string, apiKey: string, budget: Budget): Promise<any> {
  if (!budget.canAi()) return null;
  budget.ai++;
  try {
    const r = await fetch(AI_URL, {
      method: "POST",
      headers: GATEWAY_HEADERS(apiKey),
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
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return parseJsonObject(d?.choices?.[0]?.message?.content);
  } catch (_) { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const fcKey = Deno.env.get("FIRECRAWL_API_KEY");
  const lovableKey = Deno.env.get("OPENAI_API_KEY");

  if (!fcKey || !lovableKey) {
    return new Response(JSON.stringify({ error: "FIRECRAWL_API_KEY and OPENAI_API_KEY are required" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: { lead_id?: string; job_id?: string; force?: boolean; company_website?: string } = {};
  try { body = await req.json(); } catch (_) {}

  // If invoked by the dispatcher we'll get a job_id — resolve to lead_id.
  let leadId = body.lead_id;
  const jobId = body.job_id;
  const supabaseEarly = createClient(supabaseUrl, serviceKey);
  if (!leadId && jobId) {
    const { data: job } = await supabaseEarly.from("pipeline_jobs").select("lead_id").eq("id", jobId).maybeSingle();
    leadId = job?.lead_id ?? undefined;
  }
  if (!leadId) {
    if (jobId) {
      await supabaseEarly.from("pipeline_jobs").update({
        status: "failed", finished_at: new Date().toISOString(), last_error: "no lead_id",
      }).eq("id", jobId);
    }
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

  // Cache: only skip when we already have a real email/phone. A LinkedIn-only
  // partial needs another pass because Gemini search may now succeed.
  if (!body.force && !body.company_website && lead.discovery_status === "reachable" && (isUnlockedEmail(lead.decision_maker_email) || lead.decision_maker_phone)) {
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
  if (looksLikePersonName(lead.decision_maker_name)) setField(d, "name", lead.decision_maker_name, 30, "cached");
  if (lead.decision_maker_role) setField(d, "role", lead.decision_maker_role, 30, "cached");
  if (isUnlockedEmail(lead.decision_maker_email) && (scoreEmail(lead.decision_maker_email, lead.decision_maker_name) >= 45 || lead.decision_maker_email.toLowerCase().endsWith(`@${String(lead.company_website ?? "").replace(/^https?:\/\//, "").replace(/^www\./, "").toLowerCase()}`))) setField(d, "email", lead.decision_maker_email, 40, "cached");
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
        if (m && looksLikePersonName(m[1])) {
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
  } else if (isKnownOwnerName(ownerName)) {
    setField(d, "name", ownerName, 50, "deed");
    setField(d, "role", "Owner", 50, "deed");
  }

  const targetName = isKnownOwnerName(d.name) ? d.name : (isKnownOwnerName(ownerName) ? ownerName : null);

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

  if (domain && /^https?:\/\//i.test(domain)) domain = pickHostFromUrl(domain);

  if (!domain && entity && ownerName) {
    d.passes.website_discovery = true;
    const res = await fcSearch(`"${ownerName}" official site OR website`, fcKey, 4, false, budget);
    const blob = res.map((r: any) => `${r.url}\n${r.title ?? ""}\n${r.description ?? ""}`).join("\n");
    domain = pickDomainFromText(blob, ownerName);
    if (domain) {
      setField(d, "company_website", normalizeWebsite(domain), 55, "search");
      d.sources.push(domain);
    }
  } else if (domain) {
    setField(d, "company_website", normalizeWebsite(domain), body.company_website ? 90 : 60, body.company_website ? "user" : "cached");
  }

  // Confirm/scrape homepage + contact page
  if (domain) {
    const homeMd = await fcScrape(`https://${domain}`, fcKey, budget);
    if (homeMd) evidence.push(`HOMEPAGE ${domain}\n${homeMd.slice(0, 4000)}`);
    const contactMd = await fcScrape(`https://${domain}/contact`, fcKey, budget);
    if (contactMd) evidence.push(`CONTACT ${domain}\n${contactMd.slice(0, 4000)}`);
  }

  // Source records and broker/listing pages often carry the only reachable
  // path (broker phone, listing contact, press release contact). Scrape them
  // before paid/AI fallbacks so website-less owners are still actionable.
  if (lead.source_record_url) {
    d.passes.source_record_contact = true;
    const sourceMd = await fcScrape(lead.source_record_url, fcKey, budget);
    if (sourceMd) {
      evidence.push(`SOURCE RECORD ${lead.source_record_url}\n${sourceMd.slice(0, 6000)}`);
      const host = pickHostFromUrl(lead.source_record_url);
      if (!d.company_website && host && !SOCIAL_RE.test(host)) setField(d, "company_website", normalizeWebsite(host), 45, "source_record");
      const emails = pullEmails(sourceMd);
      let bestEmail: { e: string; s: number } | null = null;
      for (const e of emails) {
        const s = Math.max(scoreEmail(e, targetName), host && e.endsWith(`@${host}`) ? 55 : 0);
        if (acceptScrapedEmail(e, s, targetName, host) && (!bestEmail || s > bestEmail.s)) bestEmail = { e, s };
      }
      if (bestEmail) setField(d, "email", bestEmail.e, bestEmail.s, "source_record");
      const phones = pullPhones(sourceMd);
      let bestPhone: { p: string; s: number } | null = null;
      for (const p of phones) {
        const s = scorePhone(sourceMd, p, targetName, ownerName, host);
        if ((!bestPhone || s > bestPhone.s) && s >= 40) bestPhone = { p, s };
      }
      if (bestPhone) setField(d, "phone", bestPhone.p, bestPhone.s, "source_record");
      d.sources.push("source_record");
    }
  }


  // ============ PASS 4 — Gemini grounded public-contact hunt ============
  if ((!d.email || !d.phone) && lovableKey) {
    d.passes.gemini_public_contact = true;
    const publicHit = await geminiPublicContactHunt(lead, targetName, entity, lovableKey, fcKey, budget);
    if (publicHit && typeof publicHit === "object") {
      const c = publicHit.confidence ?? {};
      if (publicHit.name && isKnownOwnerName(publicHit.name) && looksLikePersonName(publicHit.name)) setField(d, "name", publicHit.name, c.name ?? 55, "gemini.public_search");
      if (publicHit.role) setField(d, "role", publicHit.role, c.role ?? 45, "gemini.public_search");
      if (isUnlockedEmail(publicHit.email)) setField(d, "email", publicHit.email, c.email ?? 65, "gemini.public_search");
      if (publicHit.phone && String(publicHit.phone).replace(/\D/g, "").length >= 10) setField(d, "phone", publicHit.phone, c.phone ?? 55, "gemini.public_search");
      if (publicHit.linkedin && /linkedin\.com\/in\//i.test(publicHit.linkedin)) setField(d, "linkedin", publicHit.linkedin, c.linkedin ?? 55, "gemini.public_search");
      if (publicHit.company_website) {
        const h = pickHostFromUrl(publicHit.company_website.startsWith("http") ? publicHit.company_website : `https://${publicHit.company_website}`);
        if (h) setField(d, "company_website", normalizeWebsite(h), c.company_website ?? 50, "gemini.public_search");
      }
      if (Array.isArray(publicHit.source_urls)) {
        d.sources.push("gemini:public_search", ...publicHit.source_urls.filter((u: unknown) => typeof u === "string").slice(0, 5));
        evidence.push(`GEMINI PUBLIC SEARCH\n${publicHit.source_urls.join("\n")}\n${publicHit.reasoning ?? ""}`);
      } else {
        d.sources.push("gemini:public_search");
      }
      if (publicHit.reasoning) d.notes.push(publicHit.reasoning);
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
          if (acceptScrapedEmail(e, s, targetName, domain) && (!best || s > best.s)) best = { e, s };
      }
      if (best) setField(d, "email", best.e, best.s, "scrape");
    }
    if (!d.phone && domain) {
      const ownDomainEvidence = evidence
        .filter((chunk) => chunk.toLowerCase().includes(domain!.toLowerCase()))
        .join("\n---\n");
      const phones = pullPhones(ownDomainEvidence);
      if (phones.length) setField(d, "phone", phones[0], 35, "scrape");
    }
  }

  // ============ PASS 6 — AI consolidation ============
  if (evidence.length && (!d.email || !d.linkedin || !d.name)) {
    d.passes.ai_consolidate = true;
    const blob = evidence.join("\n---\n");
    const ai = await aiConsolidate(blob, lovableKey, budget);
    if (ai && typeof ai === "object") {
      const c = ai.confidence ?? {};
      if (ai.name && isKnownOwnerName(ai.name)) setField(d, "name", ai.name, c.name ?? 50, "ai");
      if (ai.role) setField(d, "role", ai.role, c.role ?? 50, "ai");
      if (isUnlockedEmail(ai.email)) setField(d, "email", ai.email, c.email ?? 45, "ai");
      if (ai.phone && String(ai.phone).replace(/\D/g, "").length >= 10) setField(d, "phone", ai.phone, c.phone ?? 35, "ai");
      if (ai.linkedin && /linkedin\.com\/in\//i.test(ai.linkedin)) setField(d, "linkedin", ai.linkedin, c.linkedin ?? 50, "ai");
      if (ai.company_website) {
        const h = pickHostFromUrl(ai.company_website.startsWith("http") ? ai.company_website : `https://${ai.company_website}`);
        if (h) setField(d, "company_website", normalizeWebsite(h), c.company_website ?? 50, "ai");
      }
      if (ai.reasoning) d.notes.push(ai.reasoning);
      d.sources.push("gemini:consolidate");
    }
  }

  // ============ Determine status ============
  let status: "none" | "partial" | "reachable" | "failed" = "none";
  if (d.email || d.phone || d.company_website) status = "reachable";
  else if (d.linkedin || d.entity_registry_url) status = "partial";
  else status = "failed";

  // Compute completeness (0-100)
  let completeness = 0;
  if (d.company_website) completeness += 20;
  if (d.name) completeness += 15;
  if (d.email) completeness += 30;
  if (d.phone) completeness += 15;
  if (d.linkedin) completeness += 10;
  if (d.entity_registry_url) completeness += 10;

  const willBeUseful = isUsefulLead({
    decision_maker_email: d.email,
    decision_maker_phone: d.phone,
    contact_phone: d.phone ?? lead.contact_phone,
    company_website: d.company_website,
  });

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
    has_contact: willBeUseful,
    has_outreach_contact: willBeUseful,
    pipeline_stage: willBeUseful ? "enriched" : "needs_review",
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
    summary: `Discovery: ${status}${d.email ? ` · email ✓` : ""}${d.phone ? " · phone ✓" : ""}${d.linkedin ? " · LinkedIn ✓" : ""} · used ${budget.fc} FC + ${budget.ai} AI`,
    payload: { discovery: d, budget_used: budget },
  });

  // Queue brief refresh now that discovery is done (so the drawer reflects it).
  await supabase.from("pipeline_jobs").insert({
    kind: "lead_brief", lead_id: leadId, priority: 80,
  });

  // Only draft outreach when there is an actual path to reach the seller.
  if (willBeUseful && (d.email || d.phone || d.company_website)) {
    await supabase.from("pipeline_jobs").insert({
      kind: "draft_outreach", lead_id: leadId, priority: 70,
    });
  }

  if (jobId) {
    await supabase.from("pipeline_jobs").update({
      status: "done", finished_at: new Date().toISOString(),
      result: { status, useful: willBeUseful, has_email: !!d.email, has_phone: !!d.phone, has_website: !!d.company_website },
    }).eq("id", jobId);
  }

  return new Response(JSON.stringify({ ok: true, status, discovery: d, budget_used: budget }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
