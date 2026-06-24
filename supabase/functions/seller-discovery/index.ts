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
import { enqueueOnce } from "../_shared/enqueue.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FC_V2 = "https://api.firecrawl.dev/v2";
const AI_URL = "https://api.openai.com/v1/chat/completions";
const AI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
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

interface Principal {
  name: string;
  role: string | null;
  source: string; // "opencorporates" | "sos" | "bizapedia" | ...
  source_url?: string | null;
}

interface Discovery {
  name: string | null;
  role: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  company_website: string | null;
  entity_registry_url: string | null;
  related_entities: Array<{ name: string; url?: string }>;
  principals: Principal[];
  confidence_by_field: Record<string, { score: number; source: string }>;
  sources: string[];
  passes: Record<string, boolean>;
  notes: string[];
}

const empty = (): Discovery => ({
  name: null, role: null, email: null, phone: null, linkedin: null,
  company_website: null, entity_registry_url: null, related_entities: [],
  principals: [],
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

// Broker / MLS / listing-agent deny-list. If a candidate name, email, phone,
// or website matches any of these, it's almost certainly the listing agent,
// not the deed grantor — reject and keep hunting.
const BROKER_DENY_DOMAINS = [
  "compass.com", "kw.com", "kellerwilliams.com", "cbre.com", "jll.com",
  "marcusmillichap.com", "colliers.com", "cushmanwakefield.com",
  "berkshirehathawayhs.com", "century21.com", "remax.com", "coldwellbanker.com",
  "sothebysrealty.com", "douglaselliman.com", "corcoran.com", "exprealty.com",
  "har.com", "loopnet.com", "crexi.com", "zillow.com", "realtor.com",
  "redfin.com", "trulia.com",
];
const BROKER_DOMAIN_RE = new RegExp(
  "@(" + BROKER_DENY_DOMAINS.map((h) => h.replace(/\./g, "\\.")).join("|") + ")$",
  "i",
);
const BROKER_HOST_RE = new RegExp(
  "\\b(" + BROKER_DENY_DOMAINS.map((h) => h.replace(/\./g, "\\.")).join("|") + ")\\b",
  "i",
);
const BROKER_TITLE_RE =
  /\b(realtor|listing agent|broker associate|real estate agent|sales associate|leasing agent|broker\/owner|managing broker)\b/i;

function isBrokerEmail(email?: string | null): boolean {
  return !!email && BROKER_DOMAIN_RE.test(email);
}
function isBrokerHost(url?: string | null): boolean {
  const h = pickHostFromUrl(url ?? "");
  return !!h && BROKER_HOST_RE.test(h);
}
function isBrokerTitle(role?: string | null): boolean {
  return !!role && BROKER_TITLE_RE.test(role);
}

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
    if (!r.ok) { console.warn(`ai consolidate ${r.status}: ${(await r.text()).slice(0, 200)}`); return null; }
    const d = await r.json();
    return parseJsonObject(d?.choices?.[0]?.message?.content);
  } catch (_) { return null; }
  finally { clearTimeout(tid); }
}

// ====== OpenCorporates direct API (no key needed for low volume) ======
// Returns up to 5 candidate companies in the lead's jurisdiction.
async function ocSearchCompanies(entityName: string, stateCode: string | null): Promise<any[]> {
  try {
    const jurisdiction = stateCode ? `us_${stateCode.toLowerCase()}` : "";
    const url = new URL("https://api.opencorporates.com/v0.4/companies/search");
    url.searchParams.set("q", entityName);
    if (jurisdiction) url.searchParams.set("jurisdiction_code", jurisdiction);
    url.searchParams.set("per_page", "5");
    url.searchParams.set("order", "score");
    const r = await fetch(url.toString(), { headers: { "Accept": "application/json" } });
    if (!r.ok) {
      console.warn(`opencorporates ${r.status}`);
      return [];
    }
    const d = await r.json();
    return d?.results?.companies?.map((c: any) => c.company).filter(Boolean) ?? [];
  } catch (e) {
    console.warn("opencorporates threw", e);
    return [];
  }
}

// Returns the company's officers list (name, position) from OpenCorporates.
async function ocGetOfficers(jurisdiction: string, companyNumber: string): Promise<Principal[]> {
  try {
    const url = `https://api.opencorporates.com/v0.4/companies/${jurisdiction}/${companyNumber}/officers`;
    const r = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!r.ok) return [];
    const d = await r.json();
    const arr = d?.results?.officers ?? [];
    return arr.map((o: any) => o.officer).filter(Boolean).map((o: any) => ({
      name: String(o.name ?? "").trim(),
      role: o.position ? String(o.position) : null,
      source: "opencorporates",
      source_url: o.opencorporates_url ?? null,
    })).filter((p: Principal) => looksLikePersonName(p.name));
  } catch (e) {
    console.warn("opencorporates officers threw", e);
    return [];
  }
}

// Rank principals: manager > managing member > member > officer > director > registered agent.
function rankPrincipal(p: Principal): number {
  const r = (p.role ?? "").toLowerCase();
  if (/managing member|manager/.test(r)) return 100;
  if (/president|ceo|chief executive/.test(r)) return 90;
  if (/\bmember\b/.test(r)) return 80;
  if (/officer|director|principal/.test(r)) return 70;
  if (/registered agent/.test(r)) return 40;
  if (!r) return 30;
  return 20;
}

function dedupePrincipals(arr: Principal[]): Principal[] {
  const seen = new Set<string>();
  const out: Principal[] = [];
  for (const p of arr) {
    const k = p.name.toUpperCase().replace(/\s+/g, " ").trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
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

  // ============ PASS 1 — Entity unmask (MANDATORY for LLC/Trust/Corp/Estate) ============
  // We unmask the LLC to a human BEFORE any LinkedIn / web pass, so later
  // passes hunt the real person, not the entity string.
  if (entity && ownerName) {
    d.passes.entity_unmask = true;

    // 1a. OpenCorporates direct API (free, no key).
    const ocCompanies = await ocSearchCompanies(ownerName, state);
    const top = ocCompanies[0];
    if (top) {
      if (top.opencorporates_url && !d.entity_registry_url) {
        d.entity_registry_url = top.opencorporates_url;
        d.sources.push("opencorporates.com");
      }
      // Try officers endpoint for the best match.
      if (top.jurisdiction_code && top.company_number) {
        const officers = await ocGetOfficers(top.jurisdiction_code, top.company_number);
        if (officers.length) {
          d.principals.push(...officers);
          d.sources.push("opencorporates:officers");
        }
      }
    }

    // 1b. Firecrawl SoS / bizapedia search to fill gaps and grab registered agent.
    const queries = [
      `"${ownerName}" ${stateName} secretary of state business entity search`,
      `"${ownerName}" site:bizapedia.com`,
      `"${ownerName}" site:opencorporates.com`,
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
        // Pull every (role → name) match, not just the first.
        const roleRe = /(Manager|Managing Member|President|CEO|Officer|Member|Director|Registered Agent)[\s:|\-]+([A-Z][a-zA-Z'-]+\s+[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)/g;
        let mm: RegExpExecArray | null;
        while ((mm = roleRe.exec(md)) !== null) {
          if (looksLikePersonName(mm[2])) {
            d.principals.push({
              name: mm[2],
              role: mm[1],
              source: r.url && /opencorporates/.test(r.url) ? "opencorporates" : "sos",
              source_url: r.url ?? null,
            });
          }
        }
        // Related entities (other LLCs near this name)
        const rel = Array.from(md.matchAll(/([A-Z][A-Za-z0-9& ]{2,}?\s+(?:LLC|INC|CORP|LP|LLP|HOLDINGS|PARTNERS))/g))
          .map((mm2) => mm2[1])
          .filter((n) => n.toUpperCase() !== (ownerName ?? "").toUpperCase())
          .slice(0, 5);
        for (const r2 of rel) {
          if (!d.related_entities.find((e) => e.name === r2)) d.related_entities.push({ name: r2, url: r.url });
        }
      }
    }

    // 1c. Pick the best human principal — skip brokers/agents.
    d.principals = dedupePrincipals(d.principals).filter((p) => !isBrokerTitle(p.role));
    const ranked = [...d.principals].sort((a, b) => rankPrincipal(b) - rankPrincipal(a));
    const best = ranked[0];
    if (best) {
      setField(d, "name", best.name, 60, `unmask:${best.source}`);
      setField(d, "role", best.role ?? "Principal", 60, `unmask:${best.source}`);
      d.notes.push(`Unmasked ${ownerName} → ${best.name} (${best.role ?? "principal"}, via ${best.source})`);
    }
  } else if (isKnownOwnerName(ownerName)) {
    // Individual owner: the grantor on the deed IS the decision-maker.
    setField(d, "name", ownerName, 60, "deed:grantor");
    setField(d, "role", "Owner", 60, "deed:grantor");
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

  // Source records sometimes carry contact info — but ONLY if the host is
  // not a broker/MLS portal. We never want a listing agent's email.
  if (lead.source_record_url && !isBrokerHost(lead.source_record_url)) {
    d.passes.source_record_contact = true;
    const sourceMd = await fcScrape(lead.source_record_url, fcKey, budget);
    if (sourceMd) {
      evidence.push(`SOURCE RECORD ${lead.source_record_url}\n${sourceMd.slice(0, 6000)}`);
      const host = pickHostFromUrl(lead.source_record_url);
      if (!d.company_website && host && !SOCIAL_RE.test(host)) setField(d, "company_website", normalizeWebsite(host), 45, "source_record");
      const emails = pullEmails(sourceMd).filter((e) => !isBrokerEmail(e));
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
      if (isUnlockedEmail(publicHit.email) && !isBrokerEmail(publicHit.email)) setField(d, "email", publicHit.email, c.email ?? 65, "gemini.public_search");
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
      const emails = pullEmails(allEvidence).filter((e) => !isBrokerEmail(e));
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
      if (isUnlockedEmail(ai.email) && !isBrokerEmail(ai.email)) setField(d, "email", ai.email, c.email ?? 45, "ai");
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
    entity_principals: d.principals.length ? d.principals : null,
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

  // Queue brief refresh only if we don't already have one (cooldown 24h).
  await enqueueOnce(supabase, "lead_brief", leadId, {
    priority: 80,
    cooldownHours: 24,
    unlessLeadHas: [{ column: "ai_brief", op: "not_null" }],
  });

  // Track 3: profile + wealth scan for promising leads (score >= 50),
  // gated on the fields actually being missing so we don't redo them.
  if ((lead.score ?? 0) >= 50) {
    await enqueueOnce(supabase, "wealth_scan", leadId, {
      priority: 65, cooldownHours: 72,
      unlessLeadHas: [{ column: "wealth_tier", op: "not_null" }],
    });
    await enqueueOnce(supabase, "profile_seller", leadId, {
      priority: 68, cooldownHours: 72,
      unlessLeadHas: [{ column: "profiler_summary", op: "not_null" }],
    });
  }

  // Outreach drafting is now handled by outreach-cadence-tick (assigns a
  // sequence) + draft-outreach-step (drafts each step). No direct enqueue here.

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
