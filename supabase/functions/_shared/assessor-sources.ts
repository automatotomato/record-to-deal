// County assessor lookup adapters. Used by enrich-assessor to fill in
// mailing_address, assessed/market value, year built, lot/building sqft, and
// the most-recent assessor-reported sale. Free path = Firecrawl scrape with
// JSON extraction against the county's public search page.
//
// Add a county by appending to ASSESSOR_ADAPTERS. Counties not listed return
// assessor_status='unsupported_county' without burning Firecrawl credits.

const FIRECRAWL_V2 = "https://api.firecrawl.dev/v2";

export type AssessorRecord = {
  mailing_address?: string | null;
  mailing_city?: string | null;
  mailing_state?: string | null;
  mailing_zip?: string | null;
  assessed_value?: number | null;
  market_value?: number | null;
  property_type?: string | null;
  year_built?: number | null;
  lot_size_sqft?: number | null;
  building_sqft?: number | null;
  last_sale_date?: string | null;       // YYYY-MM-DD
  last_sale_price?: number | null;
  source_url: string;
};

export interface AssessorAdapter {
  id: string;
  state: string;
  county: string;
  trustedHosts: string[];
  /** Build the search URL Firecrawl will scrape, given a property address / parcel. */
  searchUrl(input: { address?: string | null; parcel?: string | null; city?: string | null; zip?: string | null }): string | null;
  /** Optional Firecrawl actions to drive a JS portal. */
  buildActions?(input: { address?: string | null; parcel?: string | null }): unknown[] | undefined;
  /** Extraction prompt hint for the JSON-mode scrape. */
  extractionPrompt: string;
}

const TCAD: AssessorAdapter = {
  id: "tcad",
  state: "TX",
  county: "Travis",
  trustedHosts: ["traviscad.org", "search.traviscad.org"],
  searchUrl({ address, parcel }) {
    if (parcel) return `https://search.traviscad.org/?keywords=${encodeURIComponent(parcel)}`;
    if (address) return `https://search.traviscad.org/?keywords=${encodeURIComponent(address)}`;
    return null;
  },
  extractionPrompt:
    "This is a Travis Central Appraisal District (TCAD) property record page. Extract the FIRST matching property: mailing address (where owner notices are sent — often different from situs/property address), assessed value (current year market value or appraised value, as a number with no $/commas), property type/use code, year built, lot size in sqft (convert acres × 43560 if needed), building/improvement sqft, last assessor-recorded sale date (YYYY-MM-DD) and price. Return null for any field not clearly shown.",
};

const ASSESSOR_ADAPTERS: AssessorAdapter[] = [TCAD];

export function findAssessorAdapter(state: string, county: string): AssessorAdapter | null {
  const s = (state ?? "").toUpperCase();
  const c = (county ?? "").toLowerCase().replace(/\s+county$/i, "").trim();
  return ASSESSOR_ADAPTERS.find((a) => a.state.toUpperCase() === s && a.county.toLowerCase() === c) ?? null;
}

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    mailing_address: { type: ["string", "null"] },
    mailing_city: { type: ["string", "null"] },
    mailing_state: { type: ["string", "null"] },
    mailing_zip: { type: ["string", "null"] },
    assessed_value: { type: ["number", "null"] },
    market_value: { type: ["number", "null"] },
    property_type: { type: ["string", "null"] },
    year_built: { type: ["integer", "null"] },
    lot_size_sqft: { type: ["integer", "null"] },
    building_sqft: { type: ["integer", "null"] },
    last_sale_date: { type: ["string", "null"] },
    last_sale_price: { type: ["number", "null"] },
  },
};

/**
 * Performs the Firecrawl scrape with JSON extraction. Returns a normalized
 * record or null if the page doesn't appear to be a usable property record.
 */
export async function lookupAssessor(
  adapter: AssessorAdapter,
  input: { address?: string | null; parcel?: string | null; city?: string | null; zip?: string | null },
  firecrawlKey: string,
): Promise<AssessorRecord | null> {
  const url = adapter.searchUrl(input);
  if (!url) return null;

  const body: Record<string, unknown> = {
    url,
    formats: [{ type: "json", schema: EXTRACTION_SCHEMA, prompt: adapter.extractionPrompt }],
    onlyMainContent: false,
    waitFor: 4000,
    timeout: 90_000,
    location: { country: "US", languages: ["en"] },
  };
  if (adapter.buildActions) {
    const actions = adapter.buildActions({ address: input.address, parcel: input.parcel });
    if (actions?.length) body.actions = actions;
  }

  const r = await fetch(`${FIRECRAWL_V2}/scrape`, {
    method: "POST",
    headers: { Authorization: `Bearer ${firecrawlKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Firecrawl ${r.status}: ${txt.slice(0, 300)}`);
  }
  const data = await r.json();
  const doc = data?.data ?? data;
  const json = doc?.json ?? doc?.extract ?? null;
  if (!json || typeof json !== "object") return null;

  // Heuristic "no record" filter: every field null → treat as not found.
  const hasAny = Object.values(json).some((v) => v !== null && v !== undefined && v !== "");
  if (!hasAny) return null;

  return {
    mailing_address: json.mailing_address ?? null,
    mailing_city: json.mailing_city ?? null,
    mailing_state: json.mailing_state ?? null,
    mailing_zip: json.mailing_zip ?? null,
    assessed_value: numOrNull(json.assessed_value),
    market_value: numOrNull(json.market_value),
    property_type: json.property_type ?? null,
    year_built: intOrNull(json.year_built),
    lot_size_sqft: intOrNull(json.lot_size_sqft),
    building_sqft: intOrNull(json.building_sqft),
    last_sale_date: dateOrNull(json.last_sale_date),
    last_sale_price: numOrNull(json.last_sale_price),
    source_url: url,
  };
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function intOrNull(v: unknown): number | null {
  const n = numOrNull(v);
  return n === null ? null : Math.round(n);
}
function dateOrNull(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  // Accept YYYY-MM-DD; try to coerce other common formats.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export const norm = (s: string | null | undefined) =>
  (s ?? "").toString().trim().toUpperCase().replace(/\s+/g, " ").replace(/[.,#]/g, "");
