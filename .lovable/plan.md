## What's actually going wrong

You're right — the Scout is getting weaker each run, and the data isn't framed around 1031 candidates. Three concrete causes:

### 1. ATTOM is returning **0 sales every single run**
Every ATTOM call is returning HTTP 400: `"Address1 and Address2 are required"`. We're calling `/sale/snapshot` with only `address2` (the city). ATTOM's snapshot endpoint requires either a full address pair OR a geo ID (`geoIdV4`) — it's not designed to pull "all sales in a city". So **ATTOM has contributed 0 leads since it was wired in.** That's the entire reason it feels like it's getting worse: we added a "primary source" that returns nothing, and Firecrawl results vary run-to-run.

The right ATTOM endpoint for "give me recent high-value sales in Clark County, NV" is `/sale/snapshot` with `geoIdV4` (county/CBSA geo IDs from ATTOM's `/area/lookup`), or `/property/snapshot` with a geoId + filters. Address-based snapshot only works one property at a time.

### 2. Each re-run finds **fewer leads** because Firecrawl returns mostly the same URLs
Firecrawl `search` with `tbs: qdr:m` (last month) hits the same LoopNet/Crexi pages repeatedly. The dedupe logic then correctly says "already have this lead" and the `leads_found` counter (which only counts **new inserts**) drops. The data is actually fine — the **counter is misleading.** It should also report "updated" and "total active leads in DB" so the user sees the pipeline growing, not shrinking.

### 3. The dashboard doesn't speak "1031 candidate"
Right now you see status/tier columns. There's no view that says "here are the X owners who just sold appreciated CRE/multifamily and have a 180-day clock ticking" — which is literally the only thing that matters.

Current data: **9 URGENT, 2 WARM, 5 COLD, 12 DISQUALIFIED.** Those 9 URGENT (Stephanie Development, GPS LV Business Park, Green Unicorns LLC, etc. — all entity-owned NV CRE sales between $2M–$11M) ARE good 1031 candidates. They're just buried.

---

## The fix (3 parts, in priority order)

### Part 1 — Make ATTOM actually work (biggest impact)
Replace the broken city-loop with the proper geoId-based call:

1. On first run per county, look up the ATTOM `geoIdV4` for that NV county via `/area/lookup` (county-level: `geoType=CO`) and cache it on the `counties` row (new column `attom_geo_id`).
2. Call `/sale/snapshot?geoIdV4={countyGeoId}&minsaleamt=500000&startsalesearchdate=...&endsalesearchdate=...&pagesize=100` — one call per county instead of one per city.
3. Page through results (ATTOM caps at 100/page).
4. Filter the response to property classes that matter for 1031: commercial, multifamily ≥4u, industrial, retail, office, hospitality, land. Drop SFR/condo unless price > $1M and owner is an entity.

This single change should take ATTOM from 0 → dozens of structured NV CRE sales per run.

### Part 2 — Make Scout results feel cumulative, not shrinking
- Track and report **`leads_updated`** alongside `leads_found` in `scout_runs` (new column) so a re-run shows "5 new, 18 refreshed" instead of "5 new" looking like a regression.
- In the dashboard "Find new leads" toast/result, show: `"Found 5 new + refreshed 18. You now have 28 active 1031 candidates."`
- Bump Firecrawl `tbs` from `qdr:m` to `qdr:w` on subsequent runs (only pull last week) so we're not re-fetching the same monthly cache. Keep `qdr:m` only for the very first run per county.

### Part 3 — Reframe the dashboard around 1031 candidates
Restructure the existing tabs (we already have Cold / Disqualified tabs from earlier work) so the primary view is:

- **"1031 Candidates"** (default tab) — `tier IN (URGENT, WARM)` AND `trigger_event IN (sale_recorded, pending_sale)` AND owner is entity (LLC/Corp/Trust). Sorted by `sale_date DESC` so the freshest 180-day clocks float to the top.
- Each row gets a pill: **"X days into 180-day window"** computed from `sale_date`, color-coded:
  - 🟢 0–45 days = "Fresh — call this week"
  - 🟡 46–135 days = "Active window"
  - 🔴 136–180 days = "Closing fast"
  - ⚫ >180 = "Window closed"
- Secondary tabs: **All Leads**, **Cold**, **Disqualified** (existing).
- A header stat strip: `"X active 1031 candidates · $Y total sale volume · $Z estimated tax exposure"`.

This makes the value of every Scout run obvious: not "how many rows did you scrape" but "how many qualified 1031 conversations are on the table right now."

---

## Files I'll change
- `supabase/functions/scout-run/index.ts` — replace `attomSalesSnapshot` with geoId-based version, add geoId lookup/cache, track `leads_updated`, tighten Firecrawl time window logic.
- Migration — add `counties.attom_geo_id text`, add `scout_runs.leads_updated int default 0`.
- `src/components/OutreachDashboard.tsx` — add "1031 Candidates" as default tab, add 180-day countdown pill, add header stat strip, update toast copy from scout result.
- `src/lib/format.ts` — add `daysSinceSale` + `windowStatus` helpers.

## What I'm NOT changing (to keep scope tight)
- Profiler / qualifier logic — those are working.
- ATTOM enrichment in profiler-run — that path uses address lookup which is correct for a single known property.
- Auth, RLS, schema beyond the two columns above.

Approve and I'll ship it.
