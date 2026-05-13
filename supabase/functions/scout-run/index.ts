// Scout agent: scrape public deed/recorder records for enabled counties
// using Firecrawl, then upsert candidate leads into the leads table.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FIRECRAWL_V2 = "https://api.firecrawl.dev/v2";
const ATTOM_BASE = "https://api.gateway.attomdata.com/propertyapi/v1.0.0";

// Map ATTOM standard land use to our property_type enum
function attomLandUseToType(use: string | undefined | null): string {
  const u = (use ?? "").toLowerCase();
  if (!u) return "Unknown";
  if (u.includes("apartment") || u.includes("multi") || u.includes("duplex") || u.includes("triplex")) return "Multifamily";
  if (u.includes("commercial") || u.includes("retail") || u.includes("office") || u.includes("industrial") || u.includes("warehouse") || u.includes("hotel")) return "Commercial";
  if (u.includes("single") || u.includes("sfr") || u.includes("residential") || u.includes("condo")) return "SFR";
  if (u.includes("land") || u.includes("vacant") || u.includes("agric")) return "Land";
  return "Unknown";
}

// Look up an ATTOM geoIdV4 for a county. Cached on counties.attom_geo_id.
async function attomLookupCountyGeoId(
  countyName: string,
  stateAbbr: string,
  apiKey: string,
): Promise<string | null> {
  // ATTOM /area/lookup expects: WhereClause + geoType. County geoType is "CO".
  const params = new URLSearchParams({
    WhereClause: `CountyName like '${countyName.toUpperCase()}' and StateAbbreviation = '${stateAbbr.toUpperCase()}'`,
    geoType: "CO",
  });
  try {
    const r = await fetch(`${ATTOM_BASE}/area/lookup?${params}`, {
      headers: { Accept: "application/json", apikey: apiKey },
    });
    if (!r.ok) {
      console.warn(`ATTOM area lookup ${countyName} ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return null;
    }
    const data = await r.json();
    const areas: Array<Record<string, any>> = data?.response?.result?.package?.item ?? data?.areas ?? [];
    const first = areas[0];
    return first?.geoIdV4 ?? first?.geoIdV3 ?? first?.geoId ?? null;
  } catch (e) {
    console.warn(`ATTOM area lookup ${countyName} failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}

// Pull recent high-value sales for a whole county via ATTOM geoIdV4.
async function attomCountySales(
  geoId: string,
  apiKey: string,
): Promise<ExtractedLead[]> {
  const out: ExtractedLead[] = [];
  const startDate = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const endDate = new Date().toISOString().slice(0, 10);
  const pageSize = 100;
  // Cap at 3 pages (300 sales/county/run) to stay within edge-function time budget.
  for (let page = 1; page <= 3; page++) {
    const params = new URLSearchParams({
      geoIdV4: geoId,
      startsalesearchdate: startDate,
      endsalesearchdate: endDate,
      minsaleamt: "500000",
      pagesize: String(pageSize),
      page: String(page),
    });
    try {
      const r = await fetch(`${ATTOM_BASE}/sale/snapshot?${params}`, {
        headers: { Accept: "application/json", apikey: apiKey },
      });
      if (!r.ok) {
        console.warn(`ATTOM snapshot page ${page} ${r.status}: ${(await r.text()).slice(0, 200)}`);
        break;
      }
      const data = await r.json();
      const props: Array<Record<string, any>> = data?.property ?? [];
      if (!props.length) break;
      for (const p of props) {
        const addr = p?.address ?? {};
        const sale = p?.sale ?? {};
        const summary = p?.summary ?? {};
        const owner = p?.owner ?? {};
        const street = addr.line1 ?? addr.oneLine ?? null;
        const ownerName =
          owner?.owner1?.fullname ??
          [owner?.owner1?.firstnameandmi, owner?.owner1?.lastname].filter(Boolean).join(" ") ??
          null;
        const price = Number(sale?.amount?.saleamt ?? sale?.saleAmountData?.saleamt ?? 0) || null;
        const saleDate = sale?.salesearchdate ?? sale?.amount?.salerecdate ?? null;
        const propType = attomLandUseToType(summary?.propclass ?? summary?.proptype);

        if (!street || !price) continue;

        // 1031 filter: keep CRE / multifamily / land / industrial. Drop SFR
        // unless price is >= $1M AND owner name looks like an entity.
        const ownerLooksEntity = ownerName ? /\b(LLC|L\.L\.C|INC|CORP|CO\.|COMPANY|TRUST|TRUSTEE|HOLDINGS|PARTNERS|LP|LLP)\b/i.test(ownerName) : false;
        if (propType === "SFR" && !(price >= 1_000_000 && ownerLooksEntity)) continue;
        if (propType === "Unknown" && price < 750_000) continue;

        out.push({
          owner_name: ownerName || undefined,
          property_address: street,
          property_city: addr.locality ?? undefined,
          property_zip: addr.postal1 ?? addr.postal ?? undefined,
          parcel_number: p?.identifier?.apn ?? undefined,
          sale_price: price,
          sale_date: saleDate ? String(saleDate).slice(0, 10) : undefined,
          deed_date: saleDate ? String(saleDate).slice(0, 10) : undefined,
          property_type: propType,
          source_record_url: `https://api.attomdata.com/property/${p?.identifier?.attomId ?? ""}`,
          trigger_event: "recent_sale",
        });
      }
      if (props.length < pageSize) break;
    } catch (e) {
      console.warn(`ATTOM snapshot page ${page} failed:`, e instanceof Error ? e.message : e);
      break;
    }
  }
  return out;
}

// Source URLs (public, no login). These are the landing/search pages we ask
// Firecrawl to render + extract structured records from. The county row
// `source_url` overrides this when present.
//
// Strategy: target CRE deal sources (LoopNet sold comps, Crexi, RealCapital)
// and assessor portals — explicitly EXCLUDE Zillow/Trulia/Realtor/Auction.com
// because those are owner-occupied MLS listings, not investor transfers.
const NV_EXCLUSIONS =
  "-site:zillow.com -site:trulia.com -site:realtor.com -site:redfin.com -site:auction.com -site:movoto.com -site:homes.com";

const COUNTY_SOURCES: Record<string, { queries: string[]; hint: string }> = {
  nv_clark: {
    queries: [
      `Las Vegas Clark County NV multifamily OR commercial OR retail OR industrial sold "$" LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com Las Vegas OR Henderson sold 2025 OR 2026`,
      `site:crexi.com "Clark County" OR "Las Vegas" sold`,
    ],
    hint:
      "Recent Clark County, Nevada (Las Vegas, Henderson, North Las Vegas, Paradise, Summerlin, Spring Valley, Sunrise Manor) INVESTMENT property transfers — multifamily ≥4-units, commercial, retail, industrial, NNN, office. Skip single-family condos and apartments under 4 units. Owner should be an LLC/Corp/Trust where possible. Extract owner name, property address, sale price (≥$500k), sale/deed date.",
  },
  nv_washoe: {
    queries: [
      `Reno Sparks Washoe County NV commercial OR multifamily OR industrial sold "$" LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com Reno OR Sparks sold`,
    ],
    hint:
      "Recent Washoe County, Nevada (Reno, Sparks, Incline Village) commercial, multifamily ≥4-units, industrial, hospitality transfers. Owner should be entity. Skip single-family. Extract owner name, address, sale price (≥$500k), date.",
  },
  nv_carson_city: {
    queries: [
      `Carson City Nevada commercial OR multifamily OR industrial sold "$" LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "Carson City, NV commercial, industrial, multifamily ≥4-units transfers. Skip residential homes. Extract owner, address, price ≥$500k, date.",
  },
  nv_douglas: {
    queries: [
      `Douglas County Nevada Minden Gardnerville Stateline commercial OR hospitality OR multifamily sold LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "Douglas County, NV (Minden, Gardnerville, Stateline / South Lake Tahoe) commercial, hospitality, multifamily ≥4-units transfers. Entity-owned only. Extract owner, address, price ≥$500k, date.",
  },
  nv_lyon: {
    queries: [
      `Lyon County Nevada Fernley Yerington Dayton industrial OR commercial sold LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "Lyon County, NV (Fernley, Dayton, Yerington) industrial, commercial, large-acreage transfers. Skip residential. Extract owner, address, price ≥$500k, date.",
  },
  nv_nye: {
    queries: [
      `Nye County Nevada Pahrump commercial OR land OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "Nye County, NV (Pahrump, Tonopah) commercial, industrial, large land transfers. Skip residential homes. Extract owner, address, price ≥$500k, date.",
  },
  nv_elko: {
    queries: [
      `Elko County Nevada commercial OR industrial OR ranch sold LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "Elko County, NV commercial, industrial, ranch / large-acreage transfers. Skip residential homes. Extract owner, address, price ≥$500k, date.",
  },
  // --- AZ ---
  az_maricopa: {
    queries: [
      `Maricopa County Arizona Phoenix Scottsdale Tempe Mesa commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com Phoenix OR Scottsdale OR Tempe sold`,
      `site:crexi.com "Maricopa County" OR Phoenix sold`,
    ],
    hint: "Maricopa County, AZ (Phoenix metro) entity-owned multifamily ≥4-units, commercial, retail, industrial, NNN, office transfers. Skip SFR/condo. Extract owner, address, price ≥$500k, date.",
  },
  az_pima: {
    queries: [
      `Pima County Arizona Tucson commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com Tucson sold`,
    ],
    hint: "Pima County, AZ (Tucson) entity-owned multifamily, commercial, industrial transfers. Skip SFR. Extract owner, address, price ≥$500k, date.",
  },
  // --- CA ---
  ca_los_angeles: {
    queries: [
      `Los Angeles County California commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com Los Angeles sold`,
      `site:crexi.com "Los Angeles" sold`,
    ],
    hint: "Los Angeles County, CA entity-owned multifamily ≥4-units, commercial, industrial, retail, office transfers. Skip SFR/condo. Extract owner, address, price ≥$1M, date.",
  },
  ca_orange: {
    queries: [
      `Orange County California Irvine Anaheim Newport commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com "Orange County" California sold`,
    ],
    hint: "Orange County, CA entity-owned multifamily, commercial, industrial transfers. Skip SFR. Extract owner, address, price ≥$1M, date.",
  },
  ca_san_diego: {
    queries: [
      `San Diego County California commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com San Diego sold`,
    ],
    hint: "San Diego County, CA entity-owned multifamily, commercial, industrial transfers. Skip SFR. Extract owner, address, price ≥$1M, date.",
  },
  ca_riverside: {
    queries: [
      `Riverside County California Palm Springs Indio Temecula industrial OR commercial OR multifamily sold LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "Riverside County, CA (Inland Empire) entity-owned industrial, commercial, multifamily transfers. Skip SFR. Extract owner, address, price ≥$750k, date.",
  },
  // --- TX ---
  tx_harris: {
    queries: [
      `Harris County Texas Houston commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com Houston sold`,
      `site:crexi.com Houston sold`,
    ],
    hint: "Harris County, TX (Houston) entity-owned multifamily ≥4-units, commercial, industrial, NNN, office transfers. Skip SFR/condo. Extract owner, address, price ≥$500k, date.",
  },
  tx_dallas: {
    queries: [
      `Dallas County Texas commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com Dallas sold`,
    ],
    hint: "Dallas County, TX entity-owned multifamily, commercial, industrial transfers. Skip SFR. Extract owner, address, price ≥$500k, date.",
  },
  tx_travis: {
    queries: [
      `Travis County Texas Austin commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com Austin sold`,
    ],
    hint: "Travis County, TX (Austin) entity-owned multifamily, commercial, industrial, office transfers. Skip SFR. Extract owner, address, price ≥$500k, date.",
  },
  tx_bexar: {
    queries: [
      `Bexar County Texas San Antonio commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "Bexar County, TX (San Antonio) entity-owned multifamily, commercial, industrial transfers. Skip SFR. Extract owner, address, price ≥$500k, date.",
  },
  // --- FL ---
  fl_miami_dade: {
    queries: [
      `Miami-Dade County Florida Miami commercial OR multifamily OR hospitality sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com Miami sold`,
      `site:crexi.com Miami sold`,
    ],
    hint: "Miami-Dade County, FL entity-owned multifamily ≥4-units, commercial, hospitality, retail transfers. Skip condo/SFR. Extract owner, address, price ≥$1M, date.",
  },
  fl_broward: {
    queries: [
      `Broward County Florida Fort Lauderdale commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "Broward County, FL (Fort Lauderdale) entity-owned multifamily, commercial, industrial transfers. Skip condo/SFR. Extract owner, address, price ≥$500k, date.",
  },
  fl_orange: {
    queries: [
      `Orange County Florida Orlando commercial OR multifamily OR hospitality sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com Orlando sold`,
    ],
    hint: "Orange County, FL (Orlando) entity-owned multifamily, commercial, hospitality transfers. Skip condo/SFR. Extract owner, address, price ≥$500k, date.",
  },
  fl_hillsborough: {
    queries: [
      `Hillsborough County Florida Tampa commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com Tampa sold`,
    ],
    hint: "Hillsborough County, FL (Tampa) entity-owned multifamily, commercial, industrial transfers. Skip condo/SFR. Extract owner, address, price ≥$500k, date.",
  },
  // --- CO ---
  co_denver: {
    queries: [
      `Denver County Colorado commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com Denver sold`,
    ],
    hint: "Denver County, CO entity-owned multifamily, commercial, industrial, office transfers. Skip SFR/condo. Extract owner, address, price ≥$500k, date.",
  },
  co_arapahoe: {
    queries: [
      `Arapahoe County Colorado Aurora Centennial commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "Arapahoe County, CO (Aurora) entity-owned multifamily, commercial, industrial transfers. Skip SFR. Extract owner, address, price ≥$500k, date.",
  },
  // --- UT ---
  ut_salt_lake: {
    queries: [
      `Salt Lake County Utah commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com "Salt Lake" sold`,
    ],
    hint: "Salt Lake County, UT entity-owned multifamily, commercial, industrial transfers. Skip SFR. Extract owner, address, price ≥$500k, date.",
  },
  // --- WA ---
  wa_king: {
    queries: [
      `King County Washington Seattle Bellevue commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com Seattle OR Bellevue sold`,
    ],
    hint: "King County, WA (Seattle/Bellevue) entity-owned multifamily ≥4-units, commercial, industrial, office transfers. Skip SFR/condo. Extract owner, address, price ≥$1M, date.",
  },
  // --- CA (high-priority, additional counties) ---
  ca_san_francisco: {
    queries: [
      `San Francisco County California commercial OR multifamily OR office sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com "San Francisco" sold`,
      `site:crexi.com "San Francisco" sold`,
    ],
    hint: "San Francisco County, CA entity-owned multifamily ≥4-units, commercial, office, retail transfers. Skip SFR/condo. Extract owner, address, price ≥$1M, date.",
  },
  ca_alameda: {
    queries: [
      `Alameda County California Oakland Berkeley commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com Oakland OR Berkeley sold`,
    ],
    hint: "Alameda County, CA (Oakland, Berkeley) entity-owned multifamily, commercial, industrial transfers. Skip SFR. Extract owner, address, price ≥$1M, date.",
  },
  ca_santa_clara: {
    queries: [
      `Santa Clara County California San Jose commercial OR multifamily OR office sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com "San Jose" OR "Santa Clara" sold`,
    ],
    hint: "Santa Clara County, CA (San Jose, Silicon Valley) entity-owned multifamily, commercial, office transfers. Skip SFR. Extract owner, address, price ≥$1M, date.",
  },
  ca_san_mateo: {
    queries: [
      `San Mateo County California commercial OR multifamily OR office sold LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "San Mateo County, CA entity-owned multifamily, commercial, office transfers. Skip SFR. Extract owner, address, price ≥$1M, date.",
  },
  ca_sacramento: {
    queries: [
      `Sacramento County California commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com Sacramento sold`,
    ],
    hint: "Sacramento County, CA entity-owned multifamily, commercial, industrial transfers. Skip SFR. Extract owner, address, price ≥$750k, date.",
  },
  // --- NY (high-priority) ---
  ny_kings: {
    queries: [
      `Brooklyn Kings County New York commercial OR multifamily OR mixed-use sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com Brooklyn sold`,
      `site:crexi.com Brooklyn sold`,
    ],
    hint: "Kings County, NY (Brooklyn) entity-owned multifamily ≥4-units, commercial, mixed-use, retail transfers. Skip SFR/condo. Extract owner, address, price ≥$1M, date.",
  },
  ny_queens: {
    queries: [
      `Queens County New York commercial OR multifamily OR mixed-use sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com Queens "New York" sold`,
    ],
    hint: "Queens County, NY entity-owned multifamily, commercial, mixed-use transfers. Skip SFR/condo. Extract owner, address, price ≥$1M, date.",
  },
  ny_bronx: {
    queries: [
      `Bronx County New York commercial OR multifamily OR mixed-use sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com Bronx sold`,
    ],
    hint: "Bronx County, NY entity-owned multifamily, commercial, mixed-use transfers. Skip SFR. Extract owner, address, price ≥$750k, date.",
  },
  ny_westchester: {
    queries: [
      `Westchester County New York commercial OR multifamily OR office sold LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "Westchester County, NY entity-owned multifamily, commercial, office transfers. Skip SFR. Extract owner, address, price ≥$1M, date.",
  },
  ny_nassau: {
    queries: [
      `Nassau County New York Long Island commercial OR multifamily OR retail sold LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "Nassau County, NY (Long Island) entity-owned multifamily, commercial, retail transfers. Skip SFR. Extract owner, address, price ≥$1M, date.",
  },
  ny_suffolk: {
    queries: [
      `Suffolk County New York Long Island commercial OR multifamily OR retail sold LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "Suffolk County, NY (Long Island) entity-owned multifamily, commercial, retail transfers. Skip SFR. Extract owner, address, price ≥$1M, date.",
  },
  // --- NJ (high-priority) ---
  nj_hudson: {
    queries: [
      `Hudson County New Jersey Jersey City Hoboken commercial OR multifamily OR mixed-use sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com "Jersey City" OR Hoboken sold`,
    ],
    hint: "Hudson County, NJ (Jersey City, Hoboken) entity-owned multifamily ≥4-units, commercial, mixed-use transfers. Skip SFR/condo. Extract owner, address, price ≥$750k, date.",
  },
  nj_essex: {
    queries: [
      `Essex County New Jersey Newark commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "Essex County, NJ (Newark) entity-owned multifamily, commercial, industrial transfers. Skip SFR. Extract owner, address, price ≥$500k, date.",
  },
  nj_middlesex: {
    queries: [
      `Middlesex County New Jersey commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "Middlesex County, NJ entity-owned multifamily, commercial, industrial transfers. Skip SFR. Extract owner, address, price ≥$500k, date.",
  },
  nj_monmouth: {
    queries: [
      `Monmouth County New Jersey commercial OR multifamily OR retail sold LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "Monmouth County, NJ entity-owned multifamily, commercial, retail transfers. Skip SFR. Extract owner, address, price ≥$500k, date.",
  },
  // --- OR (high-priority) ---
  or_washington: {
    queries: [
      `Washington County Oregon Beaverton Hillsboro commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "Washington County, OR (Beaverton, Hillsboro) entity-owned multifamily, commercial, industrial transfers. Skip SFR. Extract owner, address, price ≥$500k, date.",
  },
  or_clackamas: {
    queries: [
      `Clackamas County Oregon commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "Clackamas County, OR entity-owned multifamily, commercial, industrial transfers. Skip SFR. Extract owner, address, price ≥$500k, date.",
  },
  // --- MN (high-priority) ---
  mn_hennepin: {
    queries: [
      `Hennepin County Minnesota Minneapolis commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com Minneapolis sold`,
    ],
    hint: "Hennepin County, MN (Minneapolis) entity-owned multifamily ≥4-units, commercial, industrial, office transfers. Skip SFR. Extract owner, address, price ≥$500k, date.",
  },
  mn_ramsey: {
    queries: [
      `Ramsey County Minnesota Saint Paul commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "Ramsey County, MN (Saint Paul) entity-owned multifamily, commercial, industrial transfers. Skip SFR. Extract owner, address, price ≥$500k, date.",
  },
  // --- MA (high-priority) ---
  ma_suffolk: {
    queries: [
      `Suffolk County Massachusetts Boston commercial OR multifamily OR mixed-use sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com Boston sold`,
    ],
    hint: "Suffolk County, MA (Boston) entity-owned multifamily ≥4-units, commercial, mixed-use, office transfers. Skip SFR/condo. Extract owner, address, price ≥$1M, date.",
  },
  ma_norfolk: {
    queries: [
      `Norfolk County Massachusetts commercial OR multifamily OR retail sold LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "Norfolk County, MA entity-owned multifamily, commercial, retail transfers. Skip SFR. Extract owner, address, price ≥$750k, date.",
  },
  // --- HI (high-priority) ---
  hi_honolulu: {
    queries: [
      `Honolulu County Hawaii commercial OR multifamily OR hospitality sold LLC 2026 ${NV_EXCLUSIONS}`,
      `site:loopnet.com Honolulu sold`,
    ],
    hint: "Honolulu County, HI entity-owned multifamily, commercial, hospitality, retail transfers. Skip SFR/condo. Extract owner, address, price ≥$1M, date.",
  },
  // --- IL (high-priority extras) ---
  il_dupage: {
    queries: [
      `DuPage County Illinois commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "DuPage County, IL entity-owned multifamily, commercial, industrial transfers. Skip SFR. Extract owner, address, price ≥$500k, date.",
  },
  il_lake: {
    queries: [
      `Lake County Illinois commercial OR multifamily OR industrial sold LLC 2026 ${NV_EXCLUSIONS}`,
    ],
    hint: "Lake County, IL entity-owned multifamily, commercial, industrial transfers. Skip SFR. Extract owner, address, price ≥$500k, date.",
  },
};
  owner_name?: string;
  property_address?: string;
  property_city?: string;
  property_zip?: string;
  parcel_number?: string;
  sale_price?: number;
  sale_date?: string; // YYYY-MM-DD
  deed_date?: string;
  property_type?: string;
  source_record_url?: string;
  trigger_event?: string;
}

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    leads: {
      type: "array",
      items: {
        type: "object",
        properties: {
          owner_name: { type: "string" },
          property_address: { type: "string" },
          property_city: { type: "string" },
          property_zip: { type: "string" },
          parcel_number: { type: "string" },
          sale_price: { type: "number" },
          sale_date: { type: "string", description: "ISO date YYYY-MM-DD" },
          deed_date: { type: "string", description: "ISO date YYYY-MM-DD" },
          property_type: {
            type: "string",
            enum: [
              "SFR",
              "Multifamily",
              "Commercial",
              "Land",
              "Industrial",
              "Mixed",
              "Unknown",
            ],
          },
          source_record_url: { type: "string" },
          trigger_event: {
            type: "string",
            enum: [
              "recent_sale",
              "listed_for_sale",
              "long_hold_owner",
              "trust_transfer",
              "off_market_signal",
            ],
          },
        },
      },
    },
  },
  required: ["leads"],
};

async function firecrawlSearchAndExtract(
  query: string,
  hint: string,
  apiKey: string,
  lovableKey: string,
  tbs: string = "qdr:w",
): Promise<{ leads: ExtractedLead[]; sourceUrls: string[] }> {
  // Step 1: Firecrawl search with markdown scrape (no LLM extraction here -
  // doing it inline blows past the edge function timeout).
  const resp = await fetch(`${FIRECRAWL_V2}/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      limit: 4,
      tbs,
      scrapeOptions: { onlyMainContent: true, formats: ["markdown"] },
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(
      `Firecrawl search ${resp.status}: ${JSON.stringify(data).slice(0, 400)}`,
    );
  }
  const results: Array<Record<string, unknown>> =
    (data?.data?.web as Array<Record<string, unknown>>) ??
    (Array.isArray(data?.data) ? data.data : []) ??
    [];
  const sourceUrls: string[] = [];
  const corpus: string[] = [];
  for (const r of results) {
    const url = (r?.url as string) ?? "";
    const title = (r?.title as string) ?? "";
    const md = (r?.markdown as string) ?? (r?.description as string) ?? "";
    if (url) sourceUrls.push(url);
    corpus.push(`### ${title}\nURL: ${url}\n\n${md.slice(0, 4000)}`);
  }

  if (!corpus.length) return { leads: [], sourceUrls };

  // Step 2: One LLM extraction pass via Lovable AI Gateway over all results.
  const aiResp = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You extract structured property-transfer leads from web content. " +
              "Return ONLY valid JSON matching the provided schema. Skip records without an address or owner name.",
          },
          {
            role: "user",
            content: `${hint}\n\nReturn JSON: { "leads": [ { owner_name, property_address, property_city, property_zip, parcel_number, sale_price (number, no $/commas), sale_date (YYYY-MM-DD), deed_date (YYYY-MM-DD), property_type (one of SFR|Multifamily|Commercial|Land|Industrial|Mixed|Unknown), source_record_url, trigger_event (one of recent_sale|listed_for_sale|long_hold_owner|trust_transfer|off_market_signal) } ] }\n\nWeb content:\n\n${corpus.join("\n\n---\n\n").slice(0, 18000)}`,
          },
        ],
        response_format: { type: "json_object" },
      }),
    },
  );
  if (!aiResp.ok) {
    const t = await aiResp.text();
    throw new Error(`AI extract ${aiResp.status}: ${t.slice(0, 300)}`);
  }
  const aiData = await aiResp.json();
  const content = aiData?.choices?.[0]?.message?.content ?? "{}";
  let parsed: { leads?: ExtractedLead[] } = {};
  try { parsed = JSON.parse(content); } catch { /* ignore */ }
  const leads = Array.isArray(parsed.leads) ? parsed.leads : [];
  for (const lead of leads) {
    if (!lead.source_record_url && sourceUrls[0]) lead.source_record_url = sourceUrls[0];
  }
  return { leads, sourceUrls };
}

function inferOwnerType(name?: string) {
  if (!name) return "Unknown";
  const n = name.toLowerCase();
  if (/\bllc\b|\bl\.l\.c\b/.test(n)) return "LLC";
  if (/\btrust\b|\btrustee\b/.test(n)) return "Trust";
  if (/\bcorp\b|\binc\b|\bcompany\b|\bco\.\b/.test(n)) return "Corporation";
  if (/\bestate of\b/.test(n)) return "Estate";
  return "Individual";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");
  const lovableKey = Deno.env.get("OPENAI_API_KEY");
  const attomKey = Deno.env.get("ATTOM_API_KEY");

  if (!firecrawlKey || !lovableKey) {
    return new Response(
      JSON.stringify({ error: "FIRECRAWL_API_KEY or OPENAI_API_KEY not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // Identify caller (optional)
  let triggeredBy: string | null = null;
  try {
    const auth = req.headers.get("Authorization");
    if (auth) {
      const token = auth.replace("Bearer ", "");
      const { data } = await supabase.auth.getUser(token);
      triggeredBy = data?.user?.id ?? null;
    }
  } catch (_) { /* ignore */ }

  let body: { county_ids?: string[]; trigger_kind?: string } = {};
  try { body = await req.json(); } catch (_) { /* no body */ }

  // Mark any previous "running" runs older than 2 minutes as failed (stale)
  await supabase
    .from("scout_runs")
    .update({
      status: "failed",
      finished_at: new Date().toISOString(),
      errors: [{ message: "timed out / abandoned" }],
    })
    .eq("status", "running")
    .lt("started_at", new Date(Date.now() - 2 * 60 * 1000).toISOString());

  // Create a scout run row
  const { data: runRow, error: runErr } = await supabase
    .from("scout_runs")
    .insert({
      trigger_kind: body.trigger_kind ?? "manual",
      triggered_by: triggeredBy,
      status: "running",
    })
    .select()
    .single();
  if (runErr) {
    return new Response(JSON.stringify({ error: runErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Load enabled counties
  let countyQuery = supabase.from("counties").select("*").eq("enabled", true);
  if (body.county_ids?.length) {
    countyQuery = countyQuery.in("id", body.county_ids);
  }
  const { data: countiesRaw, error: cErr } = await countyQuery;
  // Run high-tax states first, then normal, then low. Lets the scout always
  // get to CA/NY/FL/etc before burning its budget on lower-priority states.
  const PRIO: Record<string, number> = { high: 0, normal: 1, low: 2 };
  const counties = (countiesRaw ?? []).slice().sort(
    (a: any, b: any) => (PRIO[a.priority ?? "normal"] ?? 1) - (PRIO[b.priority ?? "normal"] ?? 1),
  );
  if (cErr) {
    await supabase.from("scout_runs").update({
      status: "failed",
      finished_at: new Date().toISOString(),
      errors: [{ message: cErr.message }],
    }).eq("id", runRow.id);
    return new Response(JSON.stringify({ error: cErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Run the scrape + extraction in the background so the HTTP response can
  // return immediately. The frontend polls scout_runs to learn the outcome.
  const work = async () => {
  const errors: Array<{ county: string; message: string }> = [];
  let totalFound = 0;
  let totalUpdated = 0;
  let countiesScanned = 0;

  for (const county of counties ?? []) {
    const source = COUNTY_SOURCES[county.parser_key];
    const queries = source?.queries ?? [
      `${county.county} ${county.state} recent property sale owner LLC`,
    ];
    const hint = source?.hint ??
      `${county.county}, ${county.state} recent property transfers. Extract owner name, address, sale price/date.`;
    // First-ever run for this county? Cast a wider Firecrawl net (last month).
    // Subsequent runs only need last week — keeps results fresh and avoids
    // re-fetching the same cached search results every time.
    const firecrawlTbs = county.last_run_at ? "qdr:w" : "qdr:m";

    try {
      const extracted: ExtractedLead[] = [];
      const sourcesUsed: string[] = [county.parser_key];

      // 1. ATTOM (primary, structured): pull entire county via geoIdV4.
      if (attomKey) {
        try {
          let geoId: string | null = (county as any).attom_geo_id ?? null;
          if (!geoId) {
            geoId = await attomLookupCountyGeoId(county.county, county.state, attomKey);
            if (geoId) {
              await supabase
                .from("counties")
                .update({ attom_geo_id: geoId })
                .eq("id", county.id);
              console.log(`${county.county}: cached ATTOM geoId ${geoId}`);
            } else {
              console.warn(`${county.county}: no ATTOM geoId found`);
            }
          }
          if (geoId) {
            const attomLeads = await attomCountySales(geoId, attomKey);
            if (attomLeads.length) {
              extracted.push(...attomLeads);
              sourcesUsed.push("attom");
            }
            console.log(`${county.county}: ATTOM returned ${attomLeads.length} sales (geoId ${geoId})`);
          }
        } catch (ae) {
          const msg = ae instanceof Error ? ae.message : String(ae);
          console.warn(`ATTOM ${county.county} failed:`, msg);
          errors.push({ county: county.county, message: `attom: ${msg}` });
        }
      }

      // 2. Firecrawl (secondary, fills gaps from CRE listing sites)
      for (const q of queries) {
        try {
          const { leads } = await firecrawlSearchAndExtract(q, hint, firecrawlKey, lovableKey, firecrawlTbs);
          extracted.push(...leads);
        } catch (qe) {
          const msg = qe instanceof Error ? qe.message : String(qe);
          console.warn(`Query failed [${q}]:`, msg);
          errors.push({ county: county.county, message: `query "${q}": ${msg}` });
        }
      }
      if (extracted.length) sourcesUsed.push("firecrawl_search");
      countiesScanned += 1;
      console.log(`${county.county}: extracted ${extracted.length} total candidate leads`);

      // Build payloads, dedupe in-batch first
      const seen = new Set<string>();
      const payloads = [];
      let droppedWrongState = 0;
      let droppedHomeowner = 0;
      let droppedTooSmall = 0;
      // State name -> abbreviation for cross-checks
      const STATE_NAMES: Record<string, string> = {
        NEVADA: "NV", ARIZONA: "AZ", CALIFORNIA: "CA", TEXAS: "TX", FLORIDA: "FL",
        COLORADO: "CO", UTAH: "UT", WASHINGTON: "WA", ILLINOIS: "IL", "NEW YORK": "NY",
        OREGON: "OR", "NEW JERSEY": "NJ", MASSACHUSETTS: "MA",
      };
      for (const lead of extracted) {
        if (!lead.property_address && !lead.parcel_number) continue;
        const key = `${lead.parcel_number ?? ""}|${lead.property_address ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // --- STATE GUARD: drop a lead only when its address explicitly names
        // a different US state than the county we're scanning. ---
        const addrBlob = `${lead.property_address ?? ""} ${lead.property_city ?? ""}`.toUpperCase();
        const stateMatch = addrBlob.match(/\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/);
        const nameMatch = Object.keys(STATE_NAMES).find((n) => addrBlob.includes(n));
        const inferredState = stateMatch?.[1] ?? (nameMatch ? STATE_NAMES[nameMatch] : null);
        if (inferredState && inferredState !== county.state) {
          droppedWrongState += 1;
          continue;
        }

        // --- INVESTOR FILTER: drop owner-occupied SFR/condo/small sales ---
        const isCondoOrApt = /\b(APT|UNIT|#|STE|SUITE)\b/.test(addrBlob);
        const ownerType = inferOwnerType(lead.owner_name);
        const propLower = (lead.property_type ?? "").toLowerCase();
        const looksResidential = propLower.includes("single") || propLower.includes("sfr") || propLower === "" || isCondoOrApt;
        const price = lead.sale_price ?? 0;
        if (looksResidential && ownerType === "Individual" && price > 0 && price < 750_000) {
          droppedHomeowner += 1;
          continue;
        }
        // Skip tiny sales we can't make a 1031 case for, unless owner is clearly entity
        if (price > 0 && price < 250_000 && ownerType === "Individual") {
          droppedTooSmall += 1;
          continue;
        }

        payloads.push({
          county_id: county.id,
          state: county.state,
          county: county.county,
          owner_name: lead.owner_name ?? null,
          owner_type: ownerType,
          property_address: lead.property_address ?? null,
          property_city: lead.property_city ?? null,
          property_zip: lead.property_zip ?? null,
          parcel_number: lead.parcel_number ?? null,
          property_type: ((): string => {
            const raw = (lead.property_type ?? "Unknown").toString();
            const valid = ["SFR", "Multifamily", "Commercial", "Land", "Mixed", "Unknown"];
            if (valid.includes(raw)) return raw;
            const lower = raw.toLowerCase();
            if (lower.includes("indust") || lower.includes("office") || lower.includes("retail") || lower.includes("warehouse")) return "Commercial";
            if (lower.includes("apart") || lower.includes("multi")) return "Multifamily";
            if (lower.includes("single") || lower.includes("residential")) return "SFR";
            if (lower.includes("land") || lower.includes("vacant")) return "Land";
            return "Unknown";
          })(),
          sale_price: lead.sale_price ?? null,
          sale_date: lead.sale_date ?? null,
          deed_date: lead.deed_date ?? lead.sale_date ?? null,
          trigger_event: ((): string => {
            const map: Record<string, string> = {
              recent_sale: "sale_recorded",
              listed_for_sale: "commercial_listing",
              long_hold_owner: "listing_aged",
              trust_transfer: "probate",
              off_market_signal: "pending_sale",
            };
            return map[lead.trigger_event ?? ""] ?? "sale_recorded";
          })(),
          source_record_url: lead.source_record_url ?? null,
          data_sources: sourcesUsed,
          scout_confidence: 55,
        });
      }
      if (droppedWrongState || droppedHomeowner || droppedTooSmall) {
        console.log(`${county.county}: filtered out ${droppedWrongState} wrong-state, ${droppedHomeowner} homeowner, ${droppedTooSmall} small`);
      }

      if (payloads.length) {
        // Bulk fetch ALL existing leads in this county and dedupe in-memory
        // by normalized address OR parcel number (more robust than SQL .in()).
        const norm = (s: string | null | undefined) =>
          (s ?? "").toString().trim().toUpperCase().replace(/\s+/g, " ").replace(/[.,]/g, "");
        const { data: existing } = await supabase
          .from("leads")
          .select("id, property_address, parcel_number")
          .eq("county_id", county.id);
        const byAddr = new Map<string, string>();
        const byParcel = new Map<string, string>();
        for (const r of existing ?? []) {
          const a = norm(r.property_address);
          const p = norm(r.parcel_number);
          if (a) byAddr.set(a, r.id);
          if (p) byParcel.set(p, r.id);
        }
        const matchId = (p: typeof payloads[number]) =>
          byParcel.get(norm(p.parcel_number)) ?? byAddr.get(norm(p.property_address));

        const toInsert = payloads.filter((p) => !matchId(p));
        const toUpdate = payloads
          .map((p) => ({ p, id: matchId(p) }))
          .filter((x): x is { p: typeof payloads[number]; id: string } => !!x.id);

        if (toInsert.length) {
          const { data: inserted, error: insErr } = await supabase
            .from("leads")
            .insert(toInsert)
            .select("id");
          if (insErr) console.error("Bulk insert error:", insErr.message);
          if (inserted?.length) {
            totalFound += inserted.length;
            await supabase.from("lead_activities").insert(
              inserted.map((row) => ({
                lead_id: row.id,
                kind: "scout_found",
                summary: `Scouted from ${county.county}, ${county.state}`,
                payload: { run_id: runRow.id },
              })),
            );
          }
        }
        // Updates run in parallel (fire-and-forget chunks)
        if (toUpdate.length) {
          totalUpdated += toUpdate.length;
          await Promise.all(
            toUpdate.map(({ p, id }) =>
              supabase.from("leads").update(p).eq("id", id),
            ),
          );
        }
      }

      await supabase
        .from("counties")
        .update({ last_run_at: new Date().toISOString() })
        .eq("id", county.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Scout failed for ${county.county}:`, msg);
      errors.push({ county: county.county, message: msg });
    }
  }

  await supabase.from("scout_runs").update({
    status: errors.length && countiesScanned === 0 ? "failed" : "completed",
    finished_at: new Date().toISOString(),
    counties_scanned: countiesScanned,
    leads_found: totalFound,
    leads_updated: totalUpdated,
    errors,
  }).eq("id", runRow.id);

  // Auto-chain: qualify all UNSCORED leads, then auto-profile tier A/B
  try {
    await supabase.functions.invoke("qualifier-run", {
      body: { auto_profile: true, run_id: runRow.id },
    });
  } catch (e) {
    console.warn("Auto-qualifier failed:", e);
  }
  };

  // @ts-ignore - EdgeRuntime is provided by Supabase edge runtime
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(work());
  } else {
    work().catch((e) => console.error("Background work failed:", e));
  }

  return new Response(
    JSON.stringify({ run_id: runRow.id, status: "running", message: "Scout started in background. Poll scout_runs for results." }),
    { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
