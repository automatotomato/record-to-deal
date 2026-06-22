## Goal

Trade volume for precision. Better to surface 5 real, contactable deeded sellers per morning than 50 broker-page guesses. Tighten every gate in the scout → qualify → enrich chain so anything that can't prove it came from a recorded deed (or be unmasked to a human) gets dropped instead of saved.

## Where leads currently slip through

- `scan-sources` accepts any Firecrawl result that isn't on the broker deny-list and has an address + name. Government aggregator pages, news articles, and county "press release" pages still pass.
- AI extraction trusts the model's `grantor_name` even when the page has no deed language.
- `seller-discovery` runs LinkedIn / web passes when OpenCorporates + SoS return nothing, which re-introduces broker noise.
- No minimum confidence to graduate from `raw_candidate` → `enriched` → `ready_for_outreach`.

## Plan

### 1. Recorder-only sourcing (drop Pass 2 + Pass 3 fallbacks)

- In `scan-sources`, run **only the recorder-host query** (Pass 1). Skip the `.gov` aggregator query and the open-web fallback. Counties without a `recorder_index_url` produce zero leads instead of noisy ones — they stay parked until a recorder URL is seeded.
- Require the source page to contain deed-language tokens (`grantor`, `grantee`, `warranty deed`, `grant deed`, `quitclaim`, `book/page`, `instrument #`, `recording date`). If the scraped markdown doesn't match, discard the page before sending to the AI.
- Require the returned record to include **both** a recording date / instrument number AND a parcel/APN. No instrument # → drop.

### 2. Stricter AI extraction

- Tighten the system prompt: "If the page is not a recorded-deed index entry or deed image, return `{ leads: [] }`. Do not infer grantors from listings, news, or press releases."
- Add a `confidence` field (0–100) the model must self-report per record; reject anything < 70.
- Require `sale_price ≥ $500k` AND `property_type ∈ {Multifamily, Commercial, Industrial, Mixed, Land}`. Drop SFR/condo outright.
- Lower `MAX_RESULTS_PER_QUERY` from 5 → 3 so we spend budget on deeper scrapes, not more URLs.

### 3. Mandatory unmask before promotion

- In `seller-discovery`, if `owner_type ∈ LLC/Trust/Corp/Estate` and OpenCorporates + SoS both return no human principal, mark the lead `discovery_status = 'failed'`, `pipeline_stage = 'needs_review'`, and **do not** run LinkedIn / web passes. No principal = no outreach candidate.
- Individual grantors skip unmask but must still pass enrichment gates below.

### 4. Promotion gates (readiness tightening)

Update `compute_lead_readiness` so a lead only reaches `ready_for_outreach` when ALL are true:
- `owner_name` present AND not on broker deny-list
- `decision_maker_name` present (human, not the LLC string) AND has a verified role (`Manager | Managing Member | Member | Officer | Trustee | Owner`)
- `decision_maker_email` passes the existing regex AND domain is not a broker/MLS host AND not a generic role address (`info@`, `contact@`, `sales@`)
- `property_address` present AND `parcel_number` present
- `sale_price ≥ $500k`
- `ai_brief.why_good` present
- `scout_confidence ≥ 70`

Anything missing one of those → `needs_contact_info` or `needs_manual_review`, never `ready_for_outreach`.

### 5. Cron throttle + observability

- `run_scout_cron` already enqueues one job per enabled county. Add a per-run cap: only enqueue counties whose `last_run_at` is > 24h old (skip counties scanned the same day).
- Record per-job dropped-record counts (`page_rejected`, `confidence_too_low`, `unmask_failed`, `under_price_floor`) in `pipeline_jobs.result` so the Admin > Sources page can show why a county yielded zero leads that morning.

## Technical details

Files touched:

- `supabase/functions/scan-sources/index.ts` — remove Pass 2/3 queries, add deed-language gate, require instrument # + parcel, require self-reported `confidence ≥ 70`, drop SFR/sub-$500k.
- `supabase/functions/seller-discovery/index.ts` — short-circuit on failed unmask for entity owners; do not fall through to LinkedIn.
- `supabase/migrations/<new>.sql` — update `compute_lead_readiness` with the stricter gate; add `pipeline_jobs.result` drop-reason convention (no schema change, just docs).
- `supabase/functions/pipeline-sweeper/index.ts` (optional) — daily downgrade of leads stuck in `researching` > 7 days with no decision maker to `needs_manual_review`.
- `src/pages/Admin.tsx` — surface drop-reason counts per county on the last run.

Out of scope (will ask before doing): per-county recorder scrapers beyond Travis, paid data providers, changes to outreach cadence or email templates.
