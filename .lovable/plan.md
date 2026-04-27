## Two changes

### 1) Dashboard: only show worth-pursuing leads

Right now COLD and DISQUALIFIED still appear via the "Low priority" / "Filtered out" tabs and the "All worth pursuing" tab. You only want URGENT / HOT / WARM (and unscored, which haven't been judged yet).

**OutreachDashboard.tsx changes:**
- Remove the `cold` and `disqualified` tabs entirely.
- Tabs become just two: **1031 Candidates** (default, entity-owned recent sales) and **All active leads** (URGENT / HOT / WARM / UNSCORED).
- The base `useQuery` for leads adds `.not("tier", "in", "(COLD,DISQUALIFIED)")` so cold/disqualified rows never reach the page (and don't inflate the KPI counts).
- Update KPI strip: "Total leads" becomes "Active leads" — counted from the filtered set.
- Remove the "Cold" / "Disqualified" options from the Priority filter dropdown.
- Tax-exposure KPI now sums only active leads (which is what it should already do once cold are excluded).

Cold/disqualified leads stay in the database (so the qualifier doesn't re-create them and the scout still dedupes against them) — they're just hidden from the operator view.

### 2) Expand states + replace scout-runs chart with a progress bar

**Expand coverage.** Enable additional metro counties where ATTOM has good CRE coverage. Database migration adds these counties (enabled = true) with parser keys + Firecrawl query templates, and seeds the existing disabled rows or creates new ones:

- **AZ** — Maricopa (Phoenix), Pima (Tucson)
- **CA** — Los Angeles, Orange, San Diego, Riverside
- **TX** — Harris (Houston), Dallas, Travis (Austin), Bexar (San Antonio)
- **FL** — Miami-Dade, Broward, Orange (Orlando), Hillsborough (Tampa)
- **CO** — Denver, Arapahoe
- **UT** — Salt Lake
- **WA** — King (Seattle)
- Keep all 7 NV counties enabled.

**`scout-run/index.ts` changes:**
- Add `COUNTY_SOURCES` entries for each new parser key (same shape as the NV ones — entity-owned CRE / multifamily / industrial / land queries with the residential-site exclusions).
- Replace the hard-coded NV-only address guard (`looksNonNv`) with a generic check: drop a lead only when `lead.state` is set and doesn't match `county.state`. The existing investor-filter (drop owner-occupied SFR < $750k, drop tiny sales) stays — it's state-agnostic.
- ATTOM `/area/lookup` already takes a state — pass `county.state` instead of the hard-coded `'NV'`.

**Replace the scout-runs table on `/admin` with a live progress bar.**

The "Recent scout runs" table is removed. In its place, a single live status panel that:
- Polls `scout_runs` for the most recent row every 3s while it's `status = 'running'` (or subscribes via the existing realtime channel).
- Shows a `Progress` bar = `counties_scanned / total_enabled_counties`.
- Shows live counters: `X new · Y refreshed · Z counties scanned`.
- Shows "Last successful run: 12 min ago · 47 new · 23 refreshed" when idle.
- If the latest run has `status = 'failed'` with no progress, shows an inline error with a retry button — no table of historical failures cluttering the page.

This gives clear feedback while a run is in flight and replaces the noisy failed-runs history that wasn't useful.

## Files I'll change

- **Migration** — insert/enable new counties (AZ, CA, TX, FL, CO, UT, WA) with appropriate parser keys.
- **`supabase/functions/scout-run/index.ts`** — add `COUNTY_SOURCES` entries for each new parser key, generalize the state guard, pass `county.state` to ATTOM lookup.
- **`src/components/OutreachDashboard.tsx`** — drop cold/disqualified tabs, exclude them from the query, simplify tier filter, relabel KPI.
- **`src/pages/Admin.tsx`** — remove the "Recent scout runs" table, add a `ScoutRunStatus` panel with progress bar driven by the latest `scout_runs` row.

## Out of scope (intentionally)

- Profiler / qualifier logic.
- Adding *every* US county — sticking to top metro counties per state to keep ATTOM/Firecrawl call volume reasonable.
- Editing the historical scout_runs schema (we just stop displaying the history).

Approve and I'll ship it.