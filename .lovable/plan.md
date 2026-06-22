# Pause all automated activity

Goal: stop the project from doing anything on its own — no new scans, no enrichment, no outreach sends — without deleting code or data. Fully reversible.

## What gets paused

1. **Cron jobs** — unschedule every `pg_cron` job in this project (scout cron, dispatcher tick, sweeper, outreach cadence, reply poller, etc.). Capture their names + schedules first so we can restore them later.
2. **All enabled counties** — flip `counties.enabled = false` so even a manual run finds nothing to do.
3. **In-flight pipeline jobs** — mark every `pipeline_jobs` row in `queued` / `retry` / `running` as `cancelled` with reason `paused_by_user` so the dispatcher won't pick them up if it ever runs.
4. **Outreach sequences** — set all active `outreach_sequences` to paused so no scheduled emails go out.
5. **Admin UI banner** — add a small "System paused" indicator on `Admin.tsx` (reads a new `system_settings.paused` flag) plus a "Resume everything" button that reverses steps 1–4.

## What is NOT touched

- No edge functions deleted or undeployed (they just won't be invoked).
- No leads, touchpoints, or emails deleted.
- No secrets rotated.
- Firecrawl/Apollo/OpenAI keys stay in place.

## Technical details

- New table `public.system_settings` (single row, key/value) with a `paused boolean` flag, plus a `paused_at` / `paused_by` audit. RLS: staff read/write only, with required GRANTs.
- New migration:
  - `select cron.unschedule(jobname)` for every job in `cron.job` belonging to this project, logged into a new `paused_cron_jobs` table (jobname, schedule, command) so resume can re-`cron.schedule` them verbatim.
  - `update counties set enabled = false`.
  - `update pipeline_jobs set status='cancelled', finished_at=now(), last_error='paused_by_user' where status in ('queued','retry','running')`.
  - `update outreach_sequences set active=false` (or equivalent column — confirm during build).
  - `insert into system_settings (paused, paused_at, paused_by) values (true, now(), auth.uid())`.
- `run-scout` and `job-dispatcher` get a one-line guard at the top: if `system_settings.paused = true`, return `{ ok: true, skipped: 'paused' }` immediately. Belt-and-suspenders in case cron is somehow re-enabled.
- `Admin.tsx`: red banner "System paused — no scans, enrichment, or outreach will run" + "Resume everything" button that calls a new `resume-system` edge function (re-schedules cron from `paused_cron_jobs`, re-enables counties, clears the flag). Outreach sequences are NOT auto-resumed — user re-activates intentionally.

## Resume path

One button in Admin → `resume-system` → restores cron schedules, re-enables counties, clears `paused` flag. Cancelled jobs stay cancelled (they'd be stale); next scout run enqueues fresh ones.

## Open question

Do you also want outgoing emails already scheduled in `outreach_emails` (status `queued` / `scheduled`) cancelled, or just prevented from being sent while paused? Default in this plan: prevented (dispatcher won't run) but not cancelled, so resuming picks them back up.
