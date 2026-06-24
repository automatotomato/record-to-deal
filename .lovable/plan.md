## What I found

Yes — the pipeline is re-doing the same work many times per lead. Three concrete leaks:

**1. Daily scans don't know what's already been seen.**
`scan-sources` Firecrawls every enabled county and runs GPT extraction on every result, even when the deeds returned are ones we already have. Within-batch dedup happens *after* the AI pass; the DB unique-conflict happens *after* that. The Firecrawl + OpenAI tokens are already spent. Counties like Multnomah/Hillsborough/Maricopa have been scanned 6-14× in the last 2 days re-extracting mostly the same deeds.

**2. `lead_brief` is enqueued by three different places per lead.**
- `enrich-contact` always queues a brief.
- `seller-discovery` always queues a brief.
- `pipeline-sweeper` re-queues a brief if `ai_brief` is null.

Same lead has been briefed 100-150× in 3 days. Same pattern for `draft_outreach_step` (top lead: 469 jobs in 3 days), `wealth_scan`, `profile_seller` (3047 failures — retried in a loop).

**3. Two overlapping daily crons.**
`run-scan-daily-7am` (queues `scan_sources`) and `daily-scan-8am` (fires `job-dispatcher`) run separately. There's no idempotency window — if either is triggered manually, the chain restarts and every downstream worker re-fires.

## Changes

### A. Run once daily, behind a guard

- Delete `daily-scan-8am` and `run-scan-daily-7am`. Replace with a single `scout-daily-8am` cron that calls a new `scout-daily` edge function.
- `scout-daily` first checks a `scout_runs` row for today (UTC) — if one exists with `status in ('running','done')`, it exits with `skipped:'already_ran_today'`. Otherwise it inserts the daily `scan_sources` / `scan_external` jobs, then fires `job-dispatcher` once.
- Manual "Run scan now" buttons in Admin go through the same guard (24h cooldown per county, overridable with a confirm dialog).

### B. Skip already-seen deeds before the AI pass (the big token saver)

In `scan-sources`:
1. Before Firecrawling, load the county's existing `(parcel_number, property_address, source_record_url)` set from `leads` (last 60 days).
2. After Firecrawl returns search results, drop any result whose `url` is already in `leads.source_record_url`. If nothing remains, skip the GPT call entirely.
3. Persist a `counties.last_seen_source_urls` (jsonb, ring-buffer of last ~500 URLs) so we can short-circuit even before the DB lookup on the next run.
4. Keep `tbs=qdr:d` once a county has been run; `qdr:w` only on first run.

Expected impact: counties with no fresh deeds skip both Firecrawl scrape-options and the GPT extraction call.

### C. Idempotency guards in every worker (stop the re-enqueue loop)

Add a small helper `enqueueOnce(kind, lead_id, { unless })` used everywhere:
- Skip if a job of the same `kind+lead_id` is already `queued|retry|running`.
- Skip if a `done` job of the same kind finished in the last 24h.
- Skip if the lead already satisfies the "unless" predicate (e.g. `ai_brief IS NOT NULL` for `lead_brief`, `decision_maker_email IS NOT NULL` for `seller_discovery`).

Apply at every enqueue site:
- `enrich-contact` → only queue `seller_discovery` if no email/phone yet; only queue `lead_brief` if `ai_brief` null.
- `seller-discovery` → only queue `lead_brief` if `ai_brief` null or older than 7 days; only queue `wealth_scan`/`profile_seller` if those fields are empty.
- `pipeline-sweeper` → same predicate checks (already partially there; tighten to also skip leads updated in the last 24h).

### D. Stop the `profile_seller` retry storm

3047 failures in 3 days. Cap `attempts` at 2 in `claim_jobs` (move to `status='failed'` with `last_error='attempts exhausted'` instead of `retry`). Add an early-exit in `profile-seller` when the lead lacks the inputs it needs (no decision_maker_name yet) — return `done` with `result:{skipped:'no_dm'}` instead of failing.

### E. Tighten the sweeper

- Run weekly, not on demand.
- Add `WHERE updated_at < now() - interval '24 hours'` to every re-enqueue query so we don't re-touch leads that were just worked.

## Technical details

Files:
- `supabase/migrations/<new>.sql` — add `counties.last_seen_source_urls jsonb`, `counties.last_scanned_at timestamptz`; create cron `scout-daily-8am`; drop the two old crons.
- `supabase/functions/scout-daily/index.ts` — new, replaces the two SQL crons.
- `supabase/functions/scan-sources/index.ts` — pre-filter URLs against existing leads + `last_seen_source_urls`; short-circuit when nothing new.
- `supabase/functions/enrich-contact/index.ts`, `seller-discovery/index.ts`, `pipeline-sweeper/index.ts` — route every enqueue through `enqueueOnce()` with predicates.
- `supabase/functions/_shared/enqueue.ts` — new helper.
- `supabase/functions/profile-seller/index.ts` — early-exit when inputs missing; never throw on missing DM.
- `supabase/functions/job-dispatcher/index.ts` — claim_jobs honors a 2-attempt cap.

Out of scope: changing the AI model, changing Firecrawl plan, changing outreach cadence behavior.

## Expected outcome

- Daily Firecrawl + OpenAI cost driven primarily by *new* deeds, not by re-extracting old ones.
- Each lead's downstream chain (brief / wealth / profile / draft) runs once per phase, not 100+ times.
- Manual or accidental re-triggers are no-ops within the same day.
