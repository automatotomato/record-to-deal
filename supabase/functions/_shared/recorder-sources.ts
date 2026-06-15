// Registry of priority states + trusted county-recorder / clerk / registry-of-deeds
// domains. scan-sources only runs for states in this list; the AI extractor
// rejects any candidate whose source_record_url is NOT on one of these hosts.
//
// Priority order (highest-income / highest 1031-volume states first):
//   WA, TX, OR, CA, NY, NJ, MA, MN, FL, CO

export const PRIORITY_STATES = [
  "WA", "TX", "OR", "CA", "NY", "NJ", "MA", "MN", "FL", "CO",
] as const;

export type PriorityState = typeof PRIORITY_STATES[number];

export interface CountySource {
  /** Trusted domains for this county's recorder/clerk. Used both for site: search and to validate source URLs. */
  domains: string[];
  /** Human label for the portal (shown in UI). */
  portalName: string;
  /** Optional deep-link search URL with {from} / {to} placeholders (YYYY-MM-DD). */
  searchUrl?: string;
  /** Heavy SPA — Firecrawl should waitFor JS to render. */
  requiresJs?: boolean;
}

export interface StateSource {
  /** Domains that are valid for ANY county in this state (statewide portals like masslandrecords.com). */
  statewideDomains: string[];
  counties: Record<string, CountySource>;
  /** Free Secretary-of-State business-search URL used for LLC unmask. */
  sosBusinessSearchUrl: string;
  sosName: string;
}

export const RECORDER_REGISTRY: Record<PriorityState, StateSource> = {
  WA: {
    statewideDomains: ["wa.gov"],
    sosName: "Washington Corporations and Charities Filing System",
    sosBusinessSearchUrl: "https://ccfs.sos.wa.gov/#/BusinessSearch/BusinessInformation",
    counties: {
      "King": { portalName: "King County Recorder", domains: ["recording.kingcounty.gov", "kingcounty.gov"] },
      "Pierce": { portalName: "Pierce County Auditor", domains: ["piercecountywa.gov", "perscholas.piercecountywa.org"] },
      "Snohomish": { portalName: "Snohomish County Auditor", domains: ["snohomishcountywa.gov"] },
      "Spokane": { portalName: "Spokane County Auditor", domains: ["spokanecounty.org"] },
      "Clark": { portalName: "Clark County WA Auditor", domains: ["clark.wa.gov"] },
    },
  },
  TX: {
    statewideDomains: [],
    sosName: "Texas Comptroller Taxable Entity Search",
    sosBusinessSearchUrl: "https://mycpa.cpa.state.tx.us/coa/",
    counties: {
      "Harris": { portalName: "Harris County Clerk Real Property", domains: ["cclerk.hctx.net", "hcad.org"] },
      "Dallas": { portalName: "Dallas County Clerk Official Public Records", domains: ["dallascounty.org"] },
      "Travis": { portalName: "Travis County Clerk Official Public Records", domains: ["traviscountytx.gov", "countyclerk.traviscountytx.gov"] },
      "Bexar": { portalName: "Bexar County Clerk Official Public Records", domains: ["bexar.org"] },
      "Tarrant": { portalName: "Tarrant County Clerk Real Property", domains: ["tarrantcounty.com", "access.tarrantcounty.com"] },
      "Collin": { portalName: "Collin County Clerk", domains: ["collincountytx.gov"] },
    },
  },
  OR: {
    statewideDomains: ["oregon.gov"],
    sosName: "Oregon Secretary of State Business Registry",
    sosBusinessSearchUrl: "https://sos.oregon.gov/business/Pages/find.aspx",
    counties: {
      "Multnomah": { portalName: "Multnomah County Recording", domains: ["multco.us", "multcoproptax.com"] },
      "Washington": { portalName: "Washington County OR Records", domains: ["washingtoncountyor.gov"] },
      "Clackamas": { portalName: "Clackamas County Clerk", domains: ["clackamas.us"] },
      "Lane": { portalName: "Lane County Deeds & Records", domains: ["lanecountyor.gov"] },
      "Deschutes": { portalName: "Deschutes County Clerk", domains: ["deschutes.org"] },
    },
  },
  CA: {
    statewideDomains: [],
    sosName: "California Secretary of State bizfile Online",
    sosBusinessSearchUrl: "https://bizfileonline.sos.ca.gov/search/business",
    counties: {
      "Los Angeles": { portalName: "LA County Registrar-Recorder/County Clerk", domains: ["lavote.gov", "rrcc.lacounty.gov"] },
      "San Diego": { portalName: "San Diego County Assessor/Recorder", domains: ["arcc.sdcounty.ca.gov", "sdttc.com"] },
      "Orange": { portalName: "Orange County CA Clerk-Recorder", domains: ["ocrecorder.com", "ocgov.com"] },
      "San Francisco": { portalName: "SF Assessor-Recorder", domains: ["sfassessor.org"] },
      "Santa Clara": { portalName: "Santa Clara County Clerk-Recorder", domains: ["clerkrecorder.sccgov.org", "sccassessor.org"] },
      "Alameda": { portalName: "Alameda County Clerk-Recorder", domains: ["acgov.org"] },
      "San Mateo": { portalName: "San Mateo County Assessor-Clerk-Recorder", domains: ["smcacre.org"] },
      "Sacramento": { portalName: "Sacramento County Clerk-Recorder", domains: ["ccr.saccounty.gov"] },
      "Riverside": { portalName: "Riverside County Assessor-Recorder", domains: ["asrclkrec.com", "rivco.org"] },
      "San Bernardino": { portalName: "SB County Assessor-Recorder", domains: ["arc.sbcounty.gov"] },
    },
  },
  NY: {
    statewideDomains: [],
    sosName: "New York Department of State Corporation Search",
    sosBusinessSearchUrl: "https://apps.dos.ny.gov/publicInquiry/",
    counties: {
      "New York": { portalName: "ACRIS (NYC)", domains: ["a836-acris.nyc.gov", "nyc.gov"], requiresJs: true },
      "Kings": { portalName: "ACRIS (NYC)", domains: ["a836-acris.nyc.gov", "nyc.gov"], requiresJs: true },
      "Queens": { portalName: "ACRIS (NYC)", domains: ["a836-acris.nyc.gov", "nyc.gov"], requiresJs: true },
      "Bronx": { portalName: "ACRIS (NYC)", domains: ["a836-acris.nyc.gov", "nyc.gov"], requiresJs: true },
      "Richmond": { portalName: "Richmond County Clerk", domains: ["richmondcountyclerk.com"] },
      "Nassau": { portalName: "Nassau County Clerk", domains: ["nassaucountyny.gov"] },
      "Suffolk": { portalName: "Suffolk County Clerk", domains: ["suffolkcountyny.gov"] },
      "Westchester": { portalName: "Westchester County Clerk", domains: ["wro.westchesterclerk.com", "westchesterclerk.com"] },
    },
  },
  NJ: {
    statewideDomains: ["state.nj.us"],
    sosName: "NJ Business Records Service",
    sosBusinessSearchUrl: "https://www.njportal.com/DOR/BusinessNameSearch",
    counties: {
      "Bergen": { portalName: "Bergen County Clerk OPRS", domains: ["bergencountyclerk.org"] },
      "Essex": { portalName: "Essex County Clerk", domains: ["essexclerk.com"] },
      "Hudson": { portalName: "Hudson County Clerk", domains: ["hudsoncountyclerk.org"] },
      "Middlesex": { portalName: "Middlesex County Clerk", domains: ["middlesexcountynj.gov"] },
      "Monmouth": { portalName: "Monmouth County Clerk", domains: ["monmouthcountyclerk.com"] },
      "Morris": { portalName: "Morris County Clerk", domains: ["morriscountyclerk.org"] },
      "Union": { portalName: "Union County Clerk", domains: ["ucnj.org"] },
    },
  },
  MA: {
    // Massachusetts is statewide via masslandrecords.com
    statewideDomains: ["masslandrecords.com", "sec.state.ma.us"],
    sosName: "Massachusetts Corporations Division",
    sosBusinessSearchUrl: "https://corp.sec.state.ma.us/CorpWeb/CorpSearch/CorpSearch.aspx",
    counties: {
      "Suffolk": { portalName: "Suffolk Registry of Deeds", domains: ["masslandrecords.com", "suffolkdeeds.com"], requiresJs: true },
      "Middlesex": { portalName: "Middlesex Registry of Deeds", domains: ["masslandrecords.com", "middlesexsouthregistry.com"], requiresJs: true },
      "Norfolk": { portalName: "Norfolk Registry of Deeds", domains: ["masslandrecords.com", "norfolkdeeds.org"], requiresJs: true },
      "Worcester": { portalName: "Worcester Registry of Deeds", domains: ["masslandrecords.com", "worcesterdeeds.com"], requiresJs: true },
      "Essex": { portalName: "Essex Registry of Deeds", domains: ["masslandrecords.com", "salemdeeds.com"], requiresJs: true },
      "Plymouth": { portalName: "Plymouth Registry of Deeds", domains: ["masslandrecords.com", "plymouthdeeds.com"], requiresJs: true },
    },
  },
  MN: {
    statewideDomains: ["state.mn.us"],
    sosName: "Minnesota Business Filings Online",
    sosBusinessSearchUrl: "https://mblsportal.sos.state.mn.us/Business/Search",
    counties: {
      "Hennepin": { portalName: "Hennepin County Recorder", domains: ["hennepin.us"] },
      "Ramsey": { portalName: "Ramsey County Recorder", domains: ["ramseycounty.us"] },
      "Dakota": { portalName: "Dakota County Recorder", domains: ["dakotacounty.us", "co.dakota.mn.us"] },
      "Anoka": { portalName: "Anoka County Recorder", domains: ["anokacountymn.gov"] },
      "Washington": { portalName: "Washington County MN Recorder", domains: ["co.washington.mn.us"] },
    },
  },
  FL: {
    statewideDomains: ["myfloridacounty.com"],
    sosName: "Florida Sunbiz Corporate Records",
    sosBusinessSearchUrl: "https://search.sunbiz.org/Inquiry/CorporationSearch/ByName",
    counties: {
      "Miami-Dade": { portalName: "Miami-Dade Clerk Official Records", domains: ["onlineservices.miamidadeclerk.gov", "miamidadeclerk.gov"], requiresJs: true },
      "Broward": { portalName: "Broward County Records", domains: ["officialrecords.broward.org", "broward.org"] },
      "Palm Beach": { portalName: "Palm Beach County Clerk", domains: ["mypalmbeachclerk.com"] },
      "Orange": { portalName: "Orange County FL Comptroller", domains: ["or.occompt.com", "occompt.com"] },
      "Hillsborough": { portalName: "Hillsborough County Clerk", domains: ["hillsclerk.com"] },
      "Pinellas": { portalName: "Pinellas County Recorder", domains: ["pinellasclerk.org"] },
      "Duval": { portalName: "Duval County Clerk", domains: ["duvalclerk.com"] },
      "Lee": { portalName: "Lee County Clerk", domains: ["leeclerk.org"] },
    },
  },
  CO: {
    statewideDomains: ["colorado.gov"],
    sosName: "Colorado Secretary of State Business Search",
    sosBusinessSearchUrl: "https://www.coloradosos.gov/biz/BusinessEntityCriteriaExt.do",
    counties: {
      "Denver": { portalName: "Denver Clerk & Recorder", domains: ["denvergov.org"] },
      "Arapahoe": { portalName: "Arapahoe County Clerk & Recorder", domains: ["arapahoegov.com", "arapahoeco.gov"] },
      "Jefferson": { portalName: "Jefferson County CO Clerk", domains: ["jeffco.us"] },
      "Boulder": { portalName: "Boulder County Clerk & Recorder", domains: ["bouldercounty.gov"] },
      "Adams": { portalName: "Adams County Clerk & Recorder", domains: ["adcogov.org"] },
      "Douglas": { portalName: "Douglas County CO Clerk", domains: ["douglas.co.us"] },
      "El Paso": { portalName: "El Paso County CO Clerk & Recorder", domains: ["elpasoco.com", "clerkandrecorder.elpasoco.com"] },
    },
  },
};

/** Generic deed-aggregator / mirror domains that are NEVER trusted as recorders. */
export const FORBIDDEN_DOMAINS = [
  "loopnet", "crexi", "costar", "zillow", "trulia", "realtor.com",
  "redfin", "homes.com", "movoto", "auction.com", "bizbuysell",
  "rocketmortgage", "realestate.com", "rentcafe", "apartments.com",
];

export function isPriorityState(state: string | null | undefined): state is PriorityState {
  return !!state && (PRIORITY_STATES as readonly string[]).includes(state.toUpperCase());
}

export function getCountySource(state: string, county: string): CountySource | null {
  const s = state?.toUpperCase();
  if (!isPriorityState(s)) return null;
  const entry = RECORDER_REGISTRY[s as PriorityState];
  // Try exact, then fuzzy (strip "County", case-insensitive).
  const normalize = (x: string) => x.trim().replace(/\s+county\s*$/i, "").trim().toLowerCase();
  const wanted = normalize(county);
  for (const [name, src] of Object.entries(entry.counties)) {
    if (normalize(name) === wanted) return src;
  }
  return null;
}

export function getStateSource(state: string): StateSource | null {
  const s = state?.toUpperCase();
  if (!isPriorityState(s)) return null;
  return RECORDER_REGISTRY[s as PriorityState];
}

/** All domains that count as a "real recorder" for a given county. */
export function trustedDomainsFor(state: string, county: string): string[] {
  const cs = getCountySource(state, county);
  const ss = getStateSource(state);
  const out = new Set<string>();
  cs?.domains.forEach((d) => out.add(d));
  ss?.statewideDomains.forEach((d) => out.add(d));
  // Always allow .gov / .us official subdomains of the county slug — soft fallback.
  return Array.from(out);
}

export function urlIsTrusted(url: string | null | undefined, state: string, county: string): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (FORBIDDEN_DOMAINS.some((d) => host.includes(d))) return false;
    const trusted = trustedDomainsFor(state, county).map((d) => d.toLowerCase());
    if (trusted.some((d) => host === d || host.endsWith(`.${d}`))) return true;
    // Accept any official .gov / .us host that mentions the county slug.
    const countySlug = county.toLowerCase().replace(/\s+county$/, "").replace(/\s+/g, "");
    if ((host.endsWith(".gov") || host.endsWith(".us")) && countySlug.length >= 3 && host.includes(countySlug)) return true;
    return false;
  } catch (_) { return false; }
}
