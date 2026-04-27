
# What's actually broken (from your live data)

I pulled the current leads table to ground this in reality, not theory. The numbers are damning:

| Tier        | Count | With mailing | With owner | With tax exposure |
|-------------|-------|--------------|------------|-------------------|
| URGENT      | 33    | **0**        | 11         | 32                |
| COLD        | 23    | **0**        | 19         | 20                |
| WARM        | 2     | **0**        | 0          | 2                 |
| DISQUALIFIED| 8     | **0**        | 0          | 0                 |

**Zero leads have a mailing address.** Profiler ran 59 times. The Smarty mapping is silently failing on every property.

And the leads themselves aren't even Nevada — top "URGENT" rows are `2243 W Ainslie St #2W, Chicago` ($345k condo), `601 Ridge Rd APT 202, Wilmette IL`, `14641 Avalon Ave, Dolton IL`. These are owner-occupied condos and foreclosure auctions, not 1031 candidates. Cook County (IL) and Los Angeles (CA) are still enabled and they're producing more output than the Nevada counties because the Firecrawl queries are getting Zillow/Trulia MLS pages instead of recorder data.

# Five concrete fixes (in priority order)

## 1. Fix the silent mailing-address bug

`profiler-run` builds the mailing address from `contact_full_address` / `contact_city` / `contact_state` / `contact_zip`. Smarty's actual field names in the principal license are `mail_full_address` / `mail_city` / `mail_state` / `mail_zipcode` (the `contact_*` prefix is for an older endpoint). Result: **buildMailingAddress always returns null** even when Smarty hands back a perfect mailing record.

Fix: read both old + new field names, fall back gracefully, and log when Smarty returned a record but mapping yielded nothing so this never goes silent again.

## 2. Disable non-Nevada counties + force Nevada constraint at the search layer

- Disable `Cook` (IL) and `Los Angeles` (CA) in the `counties` table so they stop polluting results. Nevada counties stay on.
- Tighten Firecrawl queries to **exclude** Zillow/Trulia/Realtor/Auction.com (those are for-sale MLS, not recorded sales) and target the actual recorder + assessor portals plus CRE deal sources (LoopNet sold-comps, RealCapitalMarkets, Crexi).
- Add a hard `state === "NV"` filter when persisting — if Firecrawl drifted, the lead is dropped instead of saved.

## 3. Filter out owner-occupied SFR / condos at the qualifier level

Right now an SFR scoring 65 with a recent sale date gets stamped URGENT. That's a homeowner, not a 1031 candidate.

New rules:
- `property_type = SFR` AND `owner_type = Individual` AND `sale_price < $750k` → auto-`DISQUALIFIED`, regardless of recency.
- Condos (anything with `# / APT / UNIT` in the address) under $1M → same.
- URGENT requires `owner_type ∈ {LLC, Corporation, Trust}` OR `property_type ∈ {Multifamily, Commercial, Industrial, Mixed}` OR `sale_price ≥ $1M`. No exceptions.

## 4. Fix the tax-exposure formula (it currently returns wrong values)

Profiler computes `Math.max(0, assessed_value − sale_price)` as capital gains. Assessed value is almost always *below* sale price (assessors lag market), so this returns 0 — and then the qualifier overwrites with a fictional `sale_price * 0.6 * rate` fallback that's just a multiplier on the purchase price.

Real logic:
- **Basis** = previous sale price (Smarty `prior_sale_amount`) or, if missing, `assessed_land_value + improvement_value at acquisition` (Smarty has these per year).
- **Current value** = the most recent `sale_price` (if just sold) OR `market_value_year` (Smarty field) for active holds.
- **Gain** = current value − basis − selling costs (assume 6%).
- **Cap-gains tax** = gain × federal/state blended rate.
- **Recapture** = `improvement_value × min(years_held, 27.5 or 39) / depreciation_life × 25%`.
- Total exposure = both, surfaced separately so users can see what they're looking at.

Falls back gracefully if Smarty doesn't return basis (set to `null`, not a fabricated number).

## 5. Replace one-shot Firecrawl with a two-stage scout

Currently: one Firecrawl `search` per county → one LLM extract → done. The search results are dominated by SEO-heavy Zillow/Trulia. Fix:

- **Stage A (discovery)**: Firecrawl `search` with site-restricted queries:
  - `site:loopnet.com Las Vegas sold` (CRE comps)
  - `site:crexi.com Nevada sold`
  - `site:clarkcountynv.gov recorder grant deed`
  - `Las Vegas multifamily sold "$" LLC 2026 -site:zillow.com -site:trulia.com -site:realtor.com -site:auction.com`
- **Stage B (verification)**: For each candidate address, hit Smarty `search/property/principal` immediately during scout (not later in profiler). If Smarty returns no match OR returns owner-occupied SFR, drop the lead before insert. This means every lead in the table is pre-verified to exist + match the investor profile.

This collapses Scout + Profiler into a single pass and guarantees no row in the dashboard is missing owner_name / mailing_address / sale_price.

# Bonus quality-of-life

- **Dashboard**: surface a "Data quality" KPI showing `% of leads with full owner+mailing+tax`. If it drops below 80% after a run, show a warning chip on the Find new leads button so you know the run produced junk.
- **Reset**: clear the current 66 garbage leads before the new pipeline runs so the dashboard isn't polluted with the old bad data.

# Files to change

- `supabase/functions/profiler-run/index.ts` — fix Smarty field names, fix tax math, log when mapping fails
- `supabase/functions/scout-run/index.ts` — Nevada-only sources, site-exclusion queries, inline Smarty verification, drop SFR/condo noise pre-insert
- `supabase/functions/qualifier-run/index.ts` — auto-disqualify owner-occupied SFR/condo, tighten URGENT criteria
- `src/components/OutreachDashboard.tsx` — add data-quality KPI
- DB: disable Cook + LA counties, delete current 66 leads + their activities

# What you'll see after

Click **Find new leads** once. Within ~90 seconds the dashboard shows ~15-25 rows, **all in Nevada**, all with owner name + mailing address + sale price + tax exposure populated. URGENT tier only contains entity-owned investment property with sale ≤45 days old. SFR condos vanish.
