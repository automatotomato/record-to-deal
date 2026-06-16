# Scout improvement plan — Phase 1 (revised)

Scope: top 3 audit items only. No new per-county adapters yet, no paid providers. Free assessor enrichment via Firecrawl.

## 1. Scout orchestrator + cron schedules

**New edge function: `run-scout`** (`verify_jwt = true`)
- Single entry point invoked by UI (user JWT) and cron (service role).
- Authorization:
  - UI calls: require authenticated user AND `public.is_staff(auth.uid())`. Non-staff → 403.
  - Cron calls: detect service-role JWT (via `Authorization` bearer matches `SUPABASE_SERVICE_ROLE_KEY`) and bypass staff check.
  - No anon path. This is the "don't ship a public burn-credits button" guard.
- Rate limit: reject if a `scout_runs` row for the same `{kinds, states}` was created in the last 10 minutes (configurable), unless `force: true` AND caller is staff. Prevents accidental double-clicks and cron overlap.
- Input zod schema:
  ```ts
  { kinds?: ('scan_sources'|'scan_external'|'scan_county')[],
    states?: string[],   // ISO 2-letter, validated against registry
    dry_run?: boolean,
    force?: boolean }
  ```
- Behavior:
  - Resolves target counties from `_shared/recorder-sources.ts`.
  - Enqueues `pipeline_jobs` rows (one per kind/county batch) with dedupe key `scout_run_id:kind:scope` so re-runs don't pile duplicate jobs.
  - Writes one `scout_runs` row with `{kinds, states, planned_job_ids, triggered_by: 'ui'|'cron', user_id}`.
  - `dry_run: true` returns the plan without inserting jobs or scout_runs.

**Dispatcher changes (`job-dispatcher`)**
- Replace ad-hoc per-county kinds with one generic `scan_county` kind. Payload `{ adapter_id, county_id }` routes to `scan-<adapter_id>` function via a small adapter registry map kept in `_shared/county-adapter.ts` (single source of truth, no dispatcher edit per new county).
- Keep existing `scan_sources`, `scan_external`, `enrich_assessor` (new), `verify_property`. Remove the standalone `scan_travis_recordings` kind once migration is done; dispatcher keeps a back-compat shim for 1 release that maps it to `scan_county` with `adapter_id:'travis'`.
- Concurrency caps unchanged; `scan_county` cap = 1 (Firecrawl-action-heavy).

**UI wiring**
- `OutreachDashboard` + `Admin` "Run scan" → `supabase.functions.invoke('run-scout', { body: {...} })`.
- Button disabled unless `is_staff` (already loaded by `useAuth`); hidden for non-staff.
- Admin gets kinds/states multi-select; dashboard sends defaults.

**Coverage fix (audit item 2, minimal)**
- UI filters state list to states with ≥1 registry entry that has at least one source OR an adapter. IL/HI/NV/AZ/UT disappear until wired. No silent skipping.

**Cron (pg_cron + pg_net)**
Inserted via `supabase--insert` (uses project URL + anon key — must not be committed as a migration). Each schedule posts with the **service-role key** in `apikey` + `Authorization` headers so `run-scout` recognizes it as cron and bypasses staff check.
- `job-dispatcher` — every 1 min
- `pipeline-sweeper` — every 5 min
- `outreach-cadence-tick` — every 15 min
- `poll-email-replies` — every 10 min
- `run-scout` — every 6 hours, payload `{ kinds: ['scan_sources','scan_county','scan_external'] }`

Idempotency: every schedule uses `cron.schedule('<unique-name>', ...)`; rerun-safe via `cron.unschedule` first.

## 2. County adapter framework

**`_shared/county-adapter.ts`**
- Types:
  ```ts
  type Candidate = z.infer<typeof CandidateSchema>;
  interface CountyAdapter {
    id: string;             // 'travis'
    state: string;          // 'TX'
    counties: string[];     // ['Travis']
    run(ctx: AdapterCtx): Promise<Candidate[]>;
  }
  ```
- `ADAPTERS: Record<string, () => Promise<CountyAdapter>>` — lazy-imported so adding a county = 1 file + 1 registry line, no dispatcher edit.
- `runAdapter(adapter, ctx)` handles:
  - Firecrawl credit accounting (count calls, fail fast on 402 with structured error → scout_runs row records it).
  - Candidate dedupe via `sameParty` + `(recording_number, county)`.
  - Insert into `leads` with `pipeline_stage:'raw_candidate'`, `data_sources:['firecrawl:'+adapter.id]`.
  - Enqueue `verify_property` per inserted lead.
  - Writes `scout_runs` row with `{raw_url_count, trusted_url_count, extracted, inserted, rejected:{reason→count}}`.
- Shared helpers lifted from `scan-travis-recordings`: `CandidateSchema`, `inferOwnerType`, `sameParty`, `urlIsTrusted`, `aiExtractLeads`.

**Registry extension** (`_shared/recorder-sources.ts`)
- Add optional `adapter?: string` per county. When set, generic `scan-sources` skips that county; `run-scout` enqueues `scan_county` for it.

**Refactor `scan-travis-recordings`** to thin wrapper calling `runAdapter(travisAdapter, ctx)`. Behavior unchanged.

**`scout_runs` schema check**
- Before build, verify columns. If missing, add via migration: `kind text, scope jsonb, raw_url_count int, trusted_url_count int, extracted_count int, inserted_count int, rejected jsonb, triggered_by text, user_id uuid`. All nullable.

**No new counties built this phase.**

## 3. Assessor / mailing-address enrichment (Firecrawl, free)

**Migration: `leads` columns (all nullable, no backfill)**
```
mailing_address text, mailing_city text, mailing_state text, mailing_zip text,
assessed_value numeric, market_value numeric,
property_type text, year_built int, lot_size_sqft int, building_sqft int,
assessor_last_sale_date date, assessor_last_sale_price numeric,
owner_occupied boolean,
assessor_url text, assessor_fetched_at timestamptz, assessor_status text
```
- Naming: `assessor_last_sale_*` (not `last_sale_*`) to avoid collision with deed-derived fields already on `leads`.
- `assessor_status` enum-as-text: `pending | ok | not_found | unsupported_county | error`.
- No RLS change needed (extends existing `leads` table).
- Update `compute_lead_readiness` trigger? **No** — readiness rubric untouched this phase; that's audit item 9, deferred.

**`_shared/assessor-sources.ts`**
- Per-county assessor config: `{ state, county, baseUrl, searchTemplate, trustedHosts, extractionPrompt }`.
- Travis (TCAD) implemented. All other counties → `unsupported_county` (no Firecrawl call made, function exits cheap).
- `lookupAssessor()` uses Firecrawl `scrape` with `formats:[{type:'json', schema}]`, trusted-host allowlist enforced.

**New edge function: `enrich-assessor`** (`verify_jwt = false`, internal-only)
- Input zod: `{ lead_id: uuid }`.
- Guard: caller must present service-role key in `Authorization` (dispatcher always does). Returns 403 otherwise. Prevents external misuse / credit burn.
- Reads lead → resolves assessor adapter → if unsupported, sets `assessor_status='unsupported_county'` and returns. Otherwise scrapes, updates columns, computes `owner_occupied` (normalized `mailing_address` vs `property_address`).
- Dispatcher kind: `enrich_assessor`, cap 2.

**Pipeline wiring**
- `verify-property`: after Smarty normalization, enqueue `enrich_assessor` (idempotent — skip if `assessor_status='ok'` and fetched <30 days ago).
- `qualify-lead` (audit item 5, minimal): leads missing sale price/date go to `pipeline_stage:'needs_review'` and enqueue `enrich_assessor` instead of delete. Hard disqualification only when `assessor_status in ('ok','not_found')` AND still no usable signal. Disqualified leads are still **soft**-marked (`tier='DISQUALIFIED'`), not deleted — fixes the silent data loss noted in audit item 10.

## Out of scope (Phase 2)

Audit items 2 (full coverage), 6 (owner history), 7 (source-confidence rescore), 8 (external scout year), 9 (contact-quality rubric), 10 (full `scout_candidates` table).

## Security summary

- `run-scout`: JWT required, staff-only for human callers, service-role for cron, rate-limited, zod-validated.
- `enrich-assessor`: service-role-only (internal dispatcher use).
- No new anon-callable endpoints. No new RLS tables.
- Firecrawl key never touches client; all scrape calls server-side.
- Soft-delete only for disqualified leads (auditability).

## Deliverables

Created: `run-scout/`, `enrich-assessor/`, `_shared/county-adapter.ts`, `_shared/assessor-sources.ts`.
Edited: `scan-travis-recordings/` (refactor), `job-dispatcher/` (generic `scan_county` + `enrich_assessor` + back-compat shim), `verify-property/` (enqueue), `qualify-lead/` (needs_review routing, no delete), `_shared/recorder-sources.ts` (`adapter` field + state filter helper), `OutreachDashboard.tsx`, `Admin.tsx` (call `run-scout`, hide for non-staff).
DB: 1 migration (assessor columns; `scout_runs` columns if missing). 1 `supabase--insert` SQL (pg_cron schedules using service-role key).
