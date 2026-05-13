
## Goal

Tighten the pipeline so the main `/outreach` dashboard only shows leads that are scored, enriched, explained, sourced, and reachable. Replace the long-running synchronous scout with a **queued job pipeline**. Remove ATTOM entirely.

## Architecture: queued jobs (not one big function)

Today `scout-run` does discovery + qualifying + profiling inside a single edge invocation, which risks edge timeouts as soon as Firecrawl is slow. New design uses a **`pipeline_jobs` queue table** + small single-purpose workers + a cron-driven dispatcher.

```text
[ Run scan button ] ──► enqueue scan_sources jobs (1 per county) ──► return immediately
                                  │
                                  ▼
       ┌─────────────────────────────────────────────────────────┐
       │                pipeline_jobs queue                       │
       └─────────────────────────────────────────────────────────┘
                                  │
                          job-dispatcher (cron, every minute)
                                  │
        ┌─────────────┬───────────┼───────────┬─────────────┬──────────────┐
        ▼             ▼           ▼           ▼             ▼              ▼
  scan_sources  verify_property qualify_lead enrich_contact draft_outreach pipeline_sweeper
```

### Queue table

```sql
CREATE TABLE pipeline_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,             -- 'scan_sources' | 'verify_property' | 'qualify_lead' | 'enrich_contact' | 'draft_outreach'
  payload jsonb not null default '{}',
  status text not null default 'queued',  -- queued | running | done | failed | retry
  priority int not null default 100,      -- lower = sooner
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  result jsonb,
  lead_id uuid,                   -- nullable for scan_sources
  county_id uuid,                 -- nullable for non-scan jobs
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
CREATE INDEX ON pipeline_jobs (status, run_after, priority);
CREATE INDEX ON pipeline_jobs (lead_id);
```

A `claim_jobs(kind, limit, lock_id)` SQL function uses `SELECT … FOR UPDATE SKIP LOCKED` to atomically claim N pending jobs of one kind, set `status='running'`, `locked_at=now()`, `locked_by=lock_id`, and return them. Prevents two dispatchers grabbing the same job.

### Workers (one edge function each)

Each worker is small, idempotent, and short-running. It:
1. Reads its job from `pipeline_jobs` (id passed in).
2. Does ONE step.
3. Writes results to `leads` and marks the job `done` (or `failed` with `last_error` and bumps `attempts`).
4. Enqueues the **next** job in the chain on success.

Worker functions:

| Function | Job kind | Per-invocation budget | Enqueues next |
|---|---|---|---|
| `scan-sources` | `scan_sources` | 1 county, max 25 Firecrawl pages, 45s timeout | one `verify_property` job per raw candidate |
| `verify-property` | `verify_property` | 1 lead, Smarty lookup, dedup check, 15s | `qualify_lead` |
| `qualify-lead` | `qualify_lead` | 1 lead, pure logic, <1s | `enrich_contact` if `qualified`; otherwise stop |
| `enrich-contact` | `enrich_contact` | 1 lead, Apollo + Firecrawl scrape, 30s | `draft_outreach` only if `has_outreach_contact` |
| `draft-outreach` | `draft_outreach` | 1 lead, OpenAI draft, 20s | none — sets `pipeline_stage='ready'` |

Hard rules:
- **No Apollo until after `qualify_lead` succeeds.**
- **No email draft until after `enrich_contact` succeeds AND `has_outreach_contact = true`.**
- A worker NEVER enqueues for a disqualified or needs_review lead.
- Each worker checkpoints `leads.pipeline_stage` after every step so progress survives a crash.

### Dispatcher (cron, every minute)

`job-dispatcher` edge function, scheduled via `pg_cron` every 1 minute:
1. Calls `claim_jobs` per kind with concurrency caps:
   - `scan_sources`: 2 at a time
   - `verify_property`: 10
   - `qualify_lead`: 20
   - `enrich_contact`: 5 (Apollo rate limit)
   - `draft_outreach`: 5
2. For each claimed job, fires the matching worker via `supabase.functions.invoke` (fire-and-forget — does NOT await).
3. Returns a summary `{ scanned, verified, qualified, enriched, drafted }`.

Each worker also handles its own retry: on failure, set `status='retry'`, `attempts += 1`, `run_after = now() + interval '2 ^ attempts minutes'`. After `max_attempts`, mark `failed` and log a `lead_activities` entry.

### `pipeline-sweeper` (existing, repurposed)

Runs on cron at 03:00 UTC daily:
- Reset jobs stuck in `running` for >10 min back to `queued`.
- Re-enqueue leads where `pipeline_stage` is behind `tier`/`has_outreach_contact` flags (heals stragglers).
- Move sale > 180d leads to `EXPIRED`.
- Optional: clean up `done` jobs older than 7 days.

### Run-scan button (admin-only)

`POST /admin → "Run scan now"`:
1. Insert one `scan_sources` job per enabled county into `pipeline_jobs`.
2. Return `{ enqueued: N }` immediately.
3. Frontend toast: "Queued N county scans — results will appear over the next few minutes."

`PipelineHealthCard` polls `pipeline_jobs` group-by-status every 30s and shows queue depth + running counts.

## Remove ATTOM

- Strip ATTOM code from `scout-run` (which becomes `scan-sources`) and `profiler-run` (which is split into `verify-property` + `enrich-contact`).
- Drop `counties.attom_geo_id` column.
- Delete `ATTOM_API_KEY` runtime secret after deploy.
- Source proof becomes: `source_record_url` (Firecrawl), county record id, Smarty `smarty_key`, deed reference, or scraper metadata.

## Pipeline stages (lead-level)

| Stage | Visible to |
|---|---|
| `raw_candidate` | Admin |
| `pre_sale_prospect` (commercial listings) | Admin |
| `verified` | Admin |
| `qualified` | Admin |
| `enriched` | Admin |
| `ready` | **Main dashboard** |
| `needs_review` | Admin |
| `disqualified` | Admin |
| `expired` | Admin |

`ready` requires: tier ∈ (CRITICAL, URGENT, ACTIVE), score > 0, `qualification_reason`, `has_outreach_contact = true`, ≥1 source-proof field, `outreach_emails` row.

## Tier definitions (sale-recency)

- **CRITICAL** — 31–45d, contactable, strong 1031 fit
- **URGENT** — 0–30d, contactable, strong 1031 fit
- **ACTIVE** — 46–90d, strong 1031 fit
- **FOLLOW_UP** — 91–180d, admin tab only
- **EXPIRED** — 180+d, hidden by default
- **DISQUALIFIED** — fails hard filters

## Hard filters (in `qualify-lead`)

**Required to enter `qualified`:** `trigger_event ∈ ('sale_recorded','deed_recorded','transfer_recorded')` + `sale_date`; property address present OR parcel resolved via Smarty; address state matches county state; property type ∈ {Commercial, Multifamily, Industrial, Mixed, Land ≥ $250k, entity-owned residential, absentee residential, duplex/triplex/fourplex}.

**Routed to `pre_sale_prospect`:** `trigger_event = 'commercial_listing'`.

**Auto-disqualify:** owner-occupied residential; SFR/condo + Individual unless absentee/entity; $0 transfers; quitclaim; inter-family / non-arms-length; foreclosure cleanup; tax deeds w/o real price; wrong-state; sale > 180d.

## Duplicate prevention (in `verify-property`)

Before persisting, match existing leads on **(parcel_number, county)** OR **(normalized property_address, sale_date)** OR **(owner_name, sale_date, county)**. If found, **update** instead of insert. Log `lead_activities` with `kind='dedup_merged'`.

## Scoring (0–100)

| Component | Max | Notes |
|---|---|---|
| Sale recency | 25 | 0–30d=22, 31–45d=25, 46–90d=12, 91–180d=5, 180+d=0 |
| Property type | 15 | Commercial/Multifamily=15, Industrial/Mixed=12, Land=8, entity SFR=6 |
| Owner type | 15 | LLC/Corp/Trust=15, Absentee=10, Individual=0 |
| Sale price | 15 | $5M+=15, $1M+=10, $500k+=6, <$500k=2 |
| High-tax state | 10 | `state_tax_rates.is_high_tax` |
| Outreach contactability | 15 | Email=8, Phone=4, Website/LinkedIn=3 |
| Source confidence | 5 | County direct=5, Firecrawl-only=2 |

## Contactability flags

- `has_contact` — email/phone/mailing/website/LinkedIn → enables `enriched`
- `has_outreach_contact` — email/phone/website/LinkedIn only → required for `ready`

## Database migration

```sql
-- Lead columns
ALTER TABLE leads
  ADD COLUMN qualification_reason text,
  ADD COLUMN has_contact boolean NOT NULL DEFAULT false,
  ADD COLUMN has_outreach_contact boolean NOT NULL DEFAULT false,
  ADD COLUMN days_since_sale int;

-- Tier enum
ALTER TYPE lead_tier ADD VALUE IF NOT EXISTS 'CRITICAL';
ALTER TYPE lead_tier ADD VALUE IF NOT EXISTS 'ACTIVE';
ALTER TYPE lead_tier ADD VALUE IF NOT EXISTS 'FOLLOW_UP';
ALTER TYPE lead_tier ADD VALUE IF NOT EXISTS 'EXPIRED';

-- Drop ATTOM
ALTER TABLE counties DROP COLUMN attom_geo_id;

-- Job queue + claim function (see Architecture section)
CREATE TABLE pipeline_jobs (...);
CREATE FUNCTION claim_jobs(...) RETURNS SETOF pipeline_jobs ...;
```

## Edge functions

New / split:
- `scan-sources` (replaces scout-run) — one county, ≤25 Firecrawl pages, 45s budget
- `verify-property` (extracted from profiler-run) — Smarty + dedup
- `qualify-lead` (replaces qualifier-run for single-lead path; old fan-out removed)
- `enrich-contact` (extracted from profiler-run) — Apollo + Firecrawl scrape
- `draft-outreach` (extracted from profiler-run) — OpenAI email draft
- `job-dispatcher` (new) — cron-fed, fans out workers

Kept: `pipeline-sweeper` (re-purposed), `send-outreach-email`, `poll-email-replies`, `seller-discovery`.

Removed: `scout-run`, `qualifier-run`, `profiler-run` (logic migrated into the new workers).

All workers register in `supabase/config.toml` with `verify_jwt = false`.

## Frontend

- **`OutreachDashboard.tsx`**: query `pipeline_stage = 'ready' AND tier IN ('CRITICAL','URGENT','ACTIVE')` only. Show `qualification_reason` + source-proof link per row. Remove "Find new leads" button.
- **`Admin.tsx`**: tabs for Raw Candidates, Pre-sale Prospects, Verified, Qualified, Enriched, Needs Review, Follow-up, Disqualified, Expired. **Keep** "Run scan now" — but it just enqueues jobs and returns immediately.
- **`PipelineHealthCard.tsx`**: add a "Job queue" section showing counts by `kind` × `status`, plus stuck-job warning (running > 10 min).

## Out of scope

- Wealth signals (FEC/FAA/EDGAR) — deferred
- Direct-mail channel — when added, flip mailing-address gate
- County-config UI changes

## Open questions

1. **Worker concurrency** — caps above (scan=2, verify=10, qualify=20, enrich=5, draft=5) sound right, or want them lower to start?
2. **Dispatcher cadence** — every 1 min OK, or every 30s for snappier feel?
3. **Pre-sale prospects tab** — wire UI now or just create the stage and defer the tab?
