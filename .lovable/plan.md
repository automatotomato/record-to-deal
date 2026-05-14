# Pre-Scale Gap-Closure Plan

## What's already in place
- Pipeline architecture (12 edge functions, job queue, sweeper cron) — solid.
- `state_tax_rates` table loaded with correct rates for CA, NY, NJ, OR, MN, MA, etc.
- Firecrawl-grounded `seller-discovery` hits OpenCorporates + Secretary of State + LinkedIn.
- OpenAI gpt-5.1 wired across `lead-brief`, `seller-discovery`, `scan-external-sources`, `draft-outreach`.

## What's actually missing (verified against code + DB)

| # | Issue | Evidence |
|---|-------|----------|
| 1 | Scouts treat all enabled states equally | `scan-sources` and `scan-external-sources` have no state-priority logic. FL/TX/AZ/UT/WA all run at the same weight as CA/NY |
| 2 | Urgency fires on any state | `qualify-lead` URGENT requires only `days≤30 + cc>0 + strongFit`. `is_high_tax` is **not** a precondition — that's why a CO and FL lead are URGENT today |
| 3 | Tax math conflates fields | `capital_gains_estimate` actually stores `fed_tax + state_tax` (total tax owed), so it equals `total_tax_exposure`. The real gain (sale price − basis) is never stored |
| 4 | Profiler agent doesn't exist | `personality_type`, `motivation_type`, `preferred_channel`, `pitch_angle` columns are READ by `lead-brief` and the dashboard, but **no function writes them**. Drafts are generic by design |
| 5 | No wealth-signal enrichment | `wealth_signals` jsonb column exists, never populated. No FEC/FAA/EDGAR scrapers |
| 6 | Outreach is one-and-done | `draft-outreach` writes one email per lead. No follow-ups, no attorney/CPA branch, no LinkedIn touch |

Plus: the 4 Tampa/Miami leads ($94M, $65M, $20.5M, $15M) are stuck at `pipeline_stage='needs_review'` with no AI brief — `lead-brief` is gated behind `has_outreach_contact=true`, so leads without a found contact never get a brief written.

---

## Plan — 4 tracks

### Track 1 — Geographic & Urgency Targeting *(highest leverage, ~half day)*

- Add `state_tax_rates.priority_rank` column. Seed: CA=1, NY=2, NJ=3, OR=4, MN=5, MA=6, HI=7, VT=8, CT=9, MD=10, DC=11. FL gets a special **"federal-only high-volume"** flag (no state tax but huge commercial deal flow + corp sellers) → priority_rank=12 with `is_target=true`.
- Rewrite `qualify-lead` urgency:
  - **URGENT**: `is_high_tax AND days≤30 AND sale_price≥1M AND strongFit` (contact info no longer required to flag urgent — affects readiness, not urgency)
  - **CRITICAL**: same minus is_high_tax, OR is_high_tax with days 31–45
  - **ACTIVE**: days≤90 and strongFit
  - High-tax adds +15 to score (currently +10), federal-only-target (FL) adds +8.
- Fix tax math:
  - Repurpose `capital_gains_estimate` to store the **actual gain** (sale_price − basis_estimate).
  - `total_tax_exposure` stays as fed+state tax owed.
  - Add `effective_tax_rate` (computed: total_tax / gain).
  - Default basis estimate when assessed_value missing: 40% of sale_price.
- `scan-sources` and `scan-external-sources` order counties by `state_tax_rates.priority_rank` and process high-priority first. Job priority field tuned so workers drain CA/NY/NJ before TX/AZ.
- One-time backfill: re-qualify and re-enqueue `seller_discovery` + `lead_brief` for the stuck Tampa/Miami leads.

### Track 2 — Pipeline Completion Guarantee

Goal: every lead that reaches `tier ≠ DISQUALIFIED` ends with a score, contact attempt, AI brief, and a draft (or a clearly-logged failure reason).

- Remove the `has_outreach_contact` gate on `lead-brief` enqueue. Brief should run after `seller-discovery` regardless — it's the artifact a human needs to decide if a lead is worth a manual contact hunt.
- Keep `has_outreach_contact` as the gate on `draft-outreach` only.
- `pipeline-sweeper` additions: detect leads where `tier ∈ (URGENT, CRITICAL, ACTIVE)` AND `ai_brief IS NULL` AND `updated_at < now() - 30min` → re-enqueue `lead_brief`.
- New admin widget on `/outreach`: "Pipeline Health" showing per-stage funnel counts and a "stuck leads" list (qualified but no brief, or brief but no contact attempt > 24h).
- Log every OpenAI + Firecrawl call into `lead_activities` with model, latency, and outcome — gives us a real contact-find rate per source.

### Track 3 — Profiler Agent + Wealth Signals

- New edge function `profile-seller`. Runs after `seller-discovery` for any lead with `score ≥ 50`.
  - Inputs: owner_name, related entities, OpenCorporates filings, LinkedIn snippets, sale history, prior properties owned.
  - Outputs (writes back to `leads`): `personality_type` (Analytical / Driver / Amiable / Expressive), `motivation_type` (Tax avoidance / Legacy / Diversification / Liquidity), `preferred_channel` (Email / Phone / Mail / Advisor), `pitch_angle` (1–2 sentences specific to this seller), `lv_property_recommendation`.
- Wealth-signal scrapers (free public data, all via Firecrawl with cached results):
  - **FEC** (fec.gov/data) — political donations ≥ $10K → `wealth_signals[].fec`
  - **FAA aircraft registry** (registry.faa.gov) — owner name → `wealth_signals[].faa`
  - **SEC EDGAR** (efts.sec.gov/LATEST/search-index) — insider filings, beneficial ownership → `wealth_signals[].sec`
  - **Property portfolio** — OpenCorporates cross-reference of other entities owned by same principal.
- Add `wealth_tier` column: `whale` (≥3 signals OR confirmed $10M+), `affluent` (1–2 signals), `standard`. Whales get an auto-priority bump and a different outreach template.
- `lead-brief` consumes all of this so the brief explicitly cites wealth signals and pitch angle.

### Track 4 — Multi-Touch Outreach Sequence (email + LinkedIn + phone only)

- New `outreach_sequences` and `outreach_steps` tables (sequence_id, step_index, channel, delay_days, template_key, branch_condition).
- Channels in this phase: **email, LinkedIn blurb, phone-call task**. Direct mail is **out of scope for this phase**.
- Pre-built sequences:
  - **High-tax LLC seller (whale)**: T+0 email → T+2 LinkedIn connect blurb → T+5 phone-call task → T+9 email (case study) → T+15 advisor email (CPA/attorney if known) → T+22 final email
  - **High-tax individual seller**: T+0 email → T+3 LinkedIn → T+7 phone task → T+12 email → T+20 final email
  - **Federal-only (FL/TX) commercial**: T+0 email → T+4 LinkedIn → T+10 email → T+18 final email
- `draft-outreach` becomes `draft-outreach-step` — drafts the next pending step for each lead. Cron walks the sequence per lead based on last completed step + delay.
- LinkedIn step generates a 280-char connection-request blurb (manual paste — LinkedIn has no API).
- Phone-call step creates a `lead_touchpoint` task with a one-paragraph talking-points script generated from the brief.
- Attorney/CPA branch: when `seller-discovery` finds a related professional, a parallel `outreach_emails` thread is drafted to the advisor with a referral-style pitch.

---

## Out of scope (explicit, for a later phase)
- **Apollo + skip-trace integration** — deferred. Continue with Firecrawl-only contact discovery for now.
- **Direct mail / printed mailers** — deferred. No PDFs, no Lob.com, no `direct_mail_jobs` table this phase.
- AI reply classification / auto-responses.
- Multi-tenant accounts, agent assignment workflows.

## Sequencing & rough effort
1. **Track 1** (targeting + tax fix + backfill) — half day. Unblocks immediate value on the 4 Tampa/Miami leads.
2. **Track 2** (completion guarantees + observability) — half day. Tells us truthfully where leads die.
3. **Track 3** (profiler + wealth signals) — 1.5 days. Biggest credibility lift on briefs and drafts.
4. **Track 4** (email/LinkedIn/phone sequences) — 1 day.

No outstanding decisions — ready to implement on approval.
