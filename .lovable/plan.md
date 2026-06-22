
# Improve 1031 lead-flow without adding new connections

Goal: turn the existing Firecrawl + Apollo + OpenAI + Smarty stack into a sharper 1031 prospecting machine for You Decide Realty (NV-based, nationwide broker). Today the funnel produces lots of noise — 785 low-confidence leads, 566 disqualified, and only 6 leads marked ready-for-outreach. The fixes below are all software/config changes against existing tables and edge functions.

## Where the leverage is

Your data right now:
- **96 leads sold in the last 45 days** (the 1031 identification window) — these are the most valuable prospects in the system, but the UI does not surface them as such.
- **155 pre-sale prospects** (listings) sitting idle — these are the *best* 1031 prospects because you can engage *before* the clock starts.
- Geo: NY 63, CA 54, NJ 27, OR 17, MA 9, MN 7, HI 5 — high-state-tax sellers are exactly who benefit most from a 1031, and exactly who would pair well with NV replacement property.
- Property types skew Commercial (190) and Multifamily (65) — already on-thesis. SFR is correctly minimal.

## What to build

### 1. 1031 deadline tracking (frontend + small schema use)
Add two computed concepts everywhere a lead is shown:
- **Identification day** = `current_date - sale_date` out of 45.
- **Exchange day** = same out of 180.
Show a colored countdown chip (green ≤15, amber 16–35, red 36–45, grey 46+). Sort the "Ready" tab by *days remaining* by default, not by score. Pre-sale prospects get a "pre-clock" chip instead.

### 2. Pre-sale prospect track (highest ROI, currently unused)
155 listings are stuck in `pre_sale_prospect` and never reach outreach. Add:
- A dedicated "Pre-sale (no clock yet)" tab in `OutreachDashboard`.
- Have `outreach-cadence-tick` assign a new sequence key `pre_sale_advisor` to these leads so they enter cadence with a softer "planning your replacement strategy" angle.
- A new row in `outreach_sequences` + `outreach_steps` (no schema changes, just data).

### 3. NV-replacement-property angle (firm differentiator)
You Decide Realty is NV-based but most sellers are in high-tax states. Add a `replacement_market_fit` field to the AI brief (computed in `lead-brief`, not a new column) that highlights:
- High state tax state → potential NV/TX/FL replacement.
- Property type → comparable NV inventory class.
This becomes a one-line hook in the brief and the first email.

### 4. Tighter qualification + scout queries
- `scan-sources` query templates: add explicit "investment property", "NNN", "DST eligible", "apartment building ≥4 units", and exclude "owner occupied", "primary residence", "townhome", "condo unit".
- `qualify-lead`: auto-disqualify owner_type=Individual + property_type=SFR + sale_price<$750k (these will never 1031). That alone removes a large chunk of the 785 low-confidence leads going forward.
- Boost score for: entity owner + commercial/multifamily + state in high-tax set + sale in last 30 days.

### 5. Owner deduplication / portfolio plays
One LLC often appears across several sales. Add a server-side view / RPC `lead_owner_rollup` (read-only, no schema change) that groups by normalized `owner_name`. Surface a "Portfolio owner — N properties, $X total" badge on the lead row. These are whales worth a single high-touch reach.

### 6. Heal the 127 stuck leads
26 `enriched` + 101 `needs_review` are stuck. `pipeline-sweeper` already re-enqueues some of these — extend it to:
- Re-run `seller-discovery` on `needs_review` older than 48h with no recent attempt.
- Promote `enriched` + `has_outreach_contact=true` straight to `ready` and let cadence pick them up.

### 7. Outreach dashboard polish for client review
- Top-of-page "1031 Pipeline Health" strip: # sellers in 45-day window, # in 46–180 window, # pre-sale prospects, # portfolio owners, average days-to-deadline.
- Default sort: deadline ascending within "Ready".
- Per-state filter pre-populated with the 7 highest-tax states.
- Export CSV ordered by deadline (for the broker to print/work offline).

### 8. Drop dead weight from the UI
Hide `low_confidence` and `EXPIRED` from the main view by default (still reachable via filter). Today they bury the 6 ready leads visually.

## Technical notes

- All work is in existing files: `OutreachDashboard.tsx`, `lead-brief/index.ts`, `qualify-lead/index.ts`, `scan-sources/index.ts`, `outreach-cadence-tick/index.ts`, `pipeline-sweeper/index.ts`, plus a small data-only migration to seed the `pre_sale_advisor` sequence + steps and a read-only `lead_owner_rollup` view.
- No new API keys, no new vendors, no new tables beyond the view.
- Lovable AI (already wired) handles the new brief field and any A/B subject-line generation.

## Out of scope (call out, do not build)
- New data vendors (ATTOM, Reonomy, PropStream, ZoomInfo).
- Email-sending infra changes — current Gmail draft flow stays.
- Auth/role changes — RLS is already correct after last week's work.

## Suggested build order
1. Deadline countdown UI + default sort (immediate visible win for client demo).
2. Hide low_confidence/expired by default + pipeline health strip.
3. Pre-sale advisor sequence + tab.
4. Qualification rules tightening + scout query refinement.
5. Owner rollup view + portfolio badge.
6. Sweeper extensions for stuck leads.
7. Replacement-market-fit brief field.
