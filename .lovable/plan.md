
# Pipeline Tune-Up Plan

Based on the client feedback, the foundation is right but the agents need to (a) point at the right geography, (b) actually finish their work on every lead, and (c) compute urgency and tax exposure correctly. Below is what I'd change. Wealth signals + multi-touch outreach are sketched but staged for after this round.

---

## 1. Re-aim the Scout at high-tax states

**Today:** 30 enabled counties, but the heaviest weight is NV (7 counties). NV-on-NV sales have no state-tax 1031 motivation — that's exactly what the client called out.

**Change:**
- Demote all 7 NV counties to `enabled = false` for routine runs. Keep them queryable on demand (admin toggle stays).
- Promote the high-cap-gains states the client named to "priority" with a new `counties.priority` column (`high | normal | low`):
  - **High:** CA (LA, Orange, San Diego, Riverside, **+ SF, Alameda, Santa Clara, San Mateo, Sacramento**), NY (NYC 5 boroughs **+ Westchester, Nassau, Suffolk**), NJ (Bergen + **Hudson, Essex, Middlesex, Monmouth**), OR Multnomah + **Washington, Clackamas**, MN **Hennepin + Ramsey**, MA Middlesex + **Suffolk, Norfolk**, HI Honolulu, IL Cook + **DuPage, Lake**.
  - **Normal:** FL (already have Miami-Dade, Broward, Orange, Hillsborough — these are the Tampa/Orlando deals the client praised), TX, CO, WA, UT, AZ.
  - **Low/off:** NV.
- Scout loop runs `priority='high'` first, every run. `normal` runs daily, `low` weekly.
- Update the `COUNTY_SOURCES` map in `scout-run/index.ts` for the new counties (Firecrawl queries follow the existing CRE-source pattern).

**Why it matters:** Today an NV LLC→NV LLC sale gets URGENT. After this, that exact sale gets `tier='COLD'` (or skipped) and a CA/NY/FL recent commercial sale automatically wins the slot.

---

## 2. Make sure every lead finishes the pipeline

**Today's evidence (live DB):**

| state | tier | leads | with email | with personality |
|---|---|---|---|---|
| FL | UNSCORED | 19 | 0 | 0 |
| TX | UNSCORED | 29 | 0 | 0 |
| CA | UNSCORED | 14 | 0 | 0 |
| NV | URGENT | 10 | 1 | 2 |

So the Tampa/Orlando deals the client wants are sitting raw — the qualifier never reached them and the profiler never ran on them. Two root causes:

1. **`qualifier-run` is capped at 500 leads per call** and is invoked once at the very end of a scout run. If a backlog grew, only the first 500 get scored and only their tier-A/B fan out to profiler.
2. **`HUNTER_API_KEY` is not configured** (not in secrets), so every lead's Hunter pass is a silent no-op. That's why the contact-find rate is ~0%.
3. **Profiler skips when `discovery_status='reachable'` or any contact field exists** — but for a brand-new lead there's nothing cached, so the real cause of empty `personality_type` is just that profiler never got invoked for non-NV leads.

**Change:**
- Pull the 500-lead `.limit()` and instead page through UNSCORED leads in batches inside `qualifier-run` until empty.
- `qualifier-run` already auto-fans the profiler for *every* scored lead (good) but profiler concurrency is 3 — bump to 5 and add a per-batch retry on the qualifier rerun.
- Add a `pipeline_status` virtual view (or a denormalized `leads.pipeline_stage` column: `discovered | scored | profiled | enriched | drafted | ready`) so we can see at a glance which leads are stuck and where.
- Add a nightly `pipeline-sweeper` cron (1×/day) that finds any lead missing `score`, `decision_maker_*`, or a draft email and re-runs the right stage. Belt-and-suspenders for the Tampa-style stragglers.
- **Hunter.io:** add `HUNTER_API_KEY` as a secret (will prompt user). Also add a fallback provider — the client mentioned one we had better luck with; I'll confirm which (Apollo / RocketReach / Snov.io / Clearbit) and wire it as the second-choice in `seller-discovery` Pass 4.
- LLC unmask: today Pass 1 only hits OpenCorporates + Bizapedia + a generic SoS query. Add per-state SoS direct URLs (CA bizfile, NY DOS, FL Sunbiz, NJ business records, etc.) with parser patterns so we actually pull officer names, not just hope the regex catches them. Officer name → drives Pass 4 Hunter `email-finder` which is what produces the personalized email.
- Force a "draft email" stage at the end of profiler so every reachable lead has a row in `outreach_emails` with `status='draft'`. That's what powers the dashboard CTA.

---

## 3. Fix urgency + tax math

**Today's bugs:**
- URGENT fires on any recent NV LLC sale, even a $600k condo.
- `total_tax_exposure = capital_gains_estimate + depreciation_recapture` — but `capital_gains_estimate` already uses a *blended* (federal + state) rate, so the state portion isn't separable and `total_tax_exposure` double-counts.
- The blended rates (e.g. CA 0.37, NY 0.348) bake in federal 23.8% + a state estimate. The cheat sheet the client attached needs to be the source of truth for the *state* portion, kept separate.

**Change — urgency:**
- Define URGENT as: `days_since_sale ≤ 30` **AND** `state ∈ HIGH_TAX_STATES` **AND** `(owner_type ∈ {LLC, Corp, Trust} OR property_type ∈ {Multifamily, Commercial, Industrial, Land, Mixed} OR sale_price ≥ $1M)`.
- Secondary URGENT (lower badge color): NV recent sale meeting the same investor signal — still surfaced but visually de-prioritized.
- Anything outside `HIGH_TAX_STATES` and outside NV inside the 30-day window → HOT not URGENT.

**Change — tax math:** rewrite `estimateTaxExposure` to compute three separate numbers and store them:

```text
fed_capital_gains    = gain × 0.238            // 20% LTCG + 3.8% NIIT
state_capital_gains  = gain × STATE_RATE[state] // from the cheat sheet, state-only
depreciation_recap   = depreciation_taken × 0.25
total_tax_exposure   = fed + state + recapture
```

Add a `state_tax_rate` column on `leads` so the dashboard can show "CA 13.3%" next to the number. Ingest the client's cheat sheet into a new `state_tax_rates` table (state, ltcg_rate, surcharge, notes) so the rate is editable from the admin panel without a code deploy.

---

## 4. Email drafting actually uses the profile

Profiler builds `personality_type`, `motivation_type`, `pitch_angle`, `lv_property_recommendation` — but on most leads those are null because the profiler never ran (see §2). After §2 fixes coverage, also:

- Make the email-draft step a **hard requirement** at the end of profiler (today it's best-effort and silently skipped if any input is missing). When inputs are missing, fall back to a *templated* email keyed on `tier + property_type + state` instead of leaving the lead with no draft at all.
- Surface the draft's "personalization confidence" (how many profiler fields were used) in the dashboard so we can see at a glance which drafts are generic vs. tailored.

---

## 5. Staged for the next round (sketch only — confirm before building)

These are the wishlist items; I'd build them after #1–#4 are solid.

- **Wealth signals**: new `wealth-signals` edge function that, for any lead with `tier ∈ {URGENT, HOT}` or `sale_price ≥ $5M`, queries:
  - **FEC** (`api.open.fec.gov`) — political donations
  - **FAA aircraft registry** (`registry.faa.gov`) — aircraft owned
  - **SEC EDGAR** (`data.sec.gov`) — insider filings, Form 4
  Append findings to `leads.wealth_signals` jsonb (column already exists).
- **Multi-touch sequence (5–7 touches)**: new `outreach_sequences` + `outreach_steps` tables driving day-spaced touches: Day 0 email → Day 3 LinkedIn → Day 7 mailer (template pulled from 1031exchangeelite.com) → Day 14 attorney/CPA email → Day 21 follow-up email → Day 30 phone reminder. Steps are conditional on what we have (no LinkedIn → skip; no attorney → skip).
- **Dashboard pipeline view** showing each lead's stage and the next scheduled touch.

---

## Technical changes (file-by-file)

- `supabase/migrations/<new>.sql`
  - `ALTER TABLE counties ADD COLUMN priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low'))`
  - `ALTER TABLE leads ADD COLUMN pipeline_stage text DEFAULT 'discovered'`
  - `ALTER TABLE leads ADD COLUMN state_tax_rate numeric, ADD COLUMN fed_capital_gains_estimate bigint, ADD COLUMN state_capital_gains_estimate bigint`
  - `CREATE TABLE state_tax_rates (state text PK, ltcg_rate numeric, surcharge numeric, notes text)` + seed from cheat sheet
  - Update existing NV county rows to `priority='low'`, enable + seed new CA/NY/NJ/OR/MN/MA/IL/HI counties at `priority='high'`
- `supabase/functions/scout-run/index.ts`
  - County loop sorted by `priority`; add new `COUNTY_SOURCES` entries
- `supabase/functions/qualifier-run/index.ts`
  - Remove `.limit(500)`, page until done; rewrite urgency rule; pull state rate from new table; compute fed/state/recapture separately
  - Bump profiler concurrency 3 → 5
- `supabase/functions/profiler-run/index.ts`
  - Always create an `outreach_emails` draft (templated fallback)
  - Set `pipeline_stage` as it advances
- `supabase/functions/seller-discovery/index.ts`
  - Add per-state SoS URL patterns; add Hunter fallback provider
- `supabase/functions/pipeline-sweeper/index.ts` (new) + cron schedule
- `supabase/config.toml` — register `pipeline-sweeper` with `verify_jwt = false`
- Secrets: add `HUNTER_API_KEY` (and the second-provider key once you confirm which one)

---

## Open questions before I build

1. **Second contact-find provider** — which one were you using in the office (Apollo, RocketReach, Snov.io, Clearbit, other)? I'll wire whichever you pick.
2. **NV counties** — kill them entirely, or keep at `priority='low'` so they still trickle in but never crowd out CA/NY/FL?
3. **State tax cheat sheet** — drop it in this thread (PDF / CSV / pasted table all fine) and I'll seed `state_tax_rates` from it instead of guessing.
4. **Wealth signals + multi-touch** — confirm you want me to ship §1–§4 first and review before I touch §5.
