# Refocus: Out-of-State Commercial 1031 Sellers → Nevada Reinvestment

The thesis: hunt commercial property sellers in **other states** (especially high-tax ones like CA, NY, OR, NJ, MA, IL) and pitch them on rolling proceeds into **Nevada** to escape state income tax on the deferred gain. NV sellers are *not* the target — they already live in a 0-tax state and have no reason to switch jurisdictions.

## 1. Target geography: out-of-state, high-tax-first

In `qualify-lead`:
- Add a hard disqualifier: drop any lead where `state = 'NV'`. Nevada sellers don't benefit from the pitch.
- Pull `is_high_tax` + `ltcg_rate` from `state_tax_rates` (already wired) and add a **state-tax-arbitrage score** (max 20): CA/NY/NJ/OR/HI = 20, other high-tax = 15, mid-tax = 8, low-tax (TX/FL/WA/TN/SD/WY) = 3. The bigger their home-state tax bill, the bigger the NV upside.
- Surface this in `breakdown.state_arbitrage` so the dashboard can sort by it.

In `scan-sources` + cron (`run_scout_cron`):
- Keep all enabled non-NV counties active.
- Park the two NV counties (Clark, Washoe) as `enabled = false` for *seller discovery*. (They stay available as replacement-property research targets later — separate scope.)
- Bump priority on CA/NY/NJ/OR/MA/IL/HI counties so they get scanned first when manual "Find new leads" runs.

## 2. Commercial-only filter (unchanged from prior plan)

In `qualify-lead`:
- Hard-drop SFR, condo, owner-occupied, and Land < $1M.
- Require `property_type ∈ {Commercial, Multifamily, Industrial, Mixed, Retail, Office}` OR entity owner with `sale_price ≥ $750k`.
- Property-type score weights commercial/multifamily/industrial highest.

In `scan-external-sources`:
- Drop the `residential` source from manual + cron fan-out.
- Bias `commercial` and `court` queries toward entity sellers and 6–7-figure transactions in non-NV states.

## 3. Nevada pitch in profiling

In `profile-seller`:
- System prompt: every output ties the seller's **home-state tax exposure** to a **Nevada reinvestment** angle — no NV state income tax on the deferred gain, plus a concrete NV asset class match (LV/Henderson multifamily, Reno industrial, NNN retail along the I-15 corridor).
- Required JSON fields:
  - `nv_replacement_thesis` — one sentence naming a NV asset class + sub-market matched to what they sold (e.g., "Sold Bay Area garden multifamily → North Las Vegas Class B value-add").
  - `tax_savings_headline` — dollar figure = (federal LTCG + their home state's rate) × estimated gain. For CA/NY sellers this is the headline number that makes the pitch land.
  - `home_state_pain_point` — the specific state-tax fact we're rescuing them from.

## 4. Outreach copy

In `outreach-cadence-tick` draft templates:
- Subject leads with the deferral dollar amount + "Nevada" (e.g., "Defer $412k of California tax by reinvesting in Las Vegas").
- Step 1: their sale → home-state tax exposure → one NV replacement idea → 15-min call CTA.
- Step 2: case study of a same-state seller who closed in NV recently.
- Step 3: 45-day identification deadline pressure.

## 5. Dashboard reframing

In `OutreachDashboard.tsx`:
- Rename hero to "Out-of-State 1031 → Nevada Pipeline".
- New stat: **NV-bound tax deferral** = sum of `tax_savings_headline` across ready leads.
- New stat: **High-tax-state leads** = count where home state is CA/NY/NJ/OR/MA/IL/HI.
- Hide any NV-sourced leads (should be zero after step 1) and add a small banner explaining the out-of-state thesis.

## 6. Validation

- `curl_edge_functions` on `qualify-lead` against ~10 recent leads; confirm any NV lead disqualifies, CA/NY commercial leads score highest.
- Spot-check 3 profiled leads — `nv_replacement_thesis`, `tax_savings_headline`, `home_state_pain_point` all populated.
- Trigger one manual scan; verify the queue is dominated by high-tax-state counties and no NV counties are enqueued.

## Out of scope

- Building a NV replacement-property inventory (separate feature; would need a data source and a new table).
- SMS/voice outreach (email-only today).
- Recorder source coverage changes (handled in prior thread).

Approve and I'll implement 1–6 in order.
