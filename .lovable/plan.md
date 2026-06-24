## Goal
One scheduled run per day. No minute-by-minute or 15-minute crons.

## Changes

### 1. Schedule one daily cron
- Cron job `scout-daily-7am-utc` at `0 7 * * *` → POST `scout-daily`.
- Use the supabase **insert** tool (per Lovable convention for cron, since the SQL has the project URL + anon key).
- Leave every other paused cron (`job-dispatcher-every-minute`, `pipeline-sweeper-every-5min`, `outreach-cadence-tick-15m`, `daily-scan-8am`, etc.) paused. Don't reactivate them.

### 2. Make the one daily run actually drain the queue
`scout-daily` currently queues jobs and fires the dispatcher once — that processes only ~10 jobs total, leaving ~80 queued forever (since there's no recurring dispatcher).

Update `supabase/functions/scout-daily/index.ts` to:
- Also queue `scan_presale` per state (currently missing).
- After queuing, run an internal **drain loop**: invoke `job-dispatcher` every 20 seconds in a background task (`EdgeRuntime.waitUntil`) until either (a) two consecutive dispatcher calls return 0 jobs dispatched, or (b) a 20-minute hard ceiling is hit.
- Return immediately (the loop runs in the background).

This is still one cron firing per day — the loop just lets that one run finish the work it queued, instead of dying after the first dispatch.

### 3. Outreach cadence
`outreach-cadence-tick` was on a 15-min cron and is now paused. Add it to the same daily run so scheduled outreach emails still go out — call it once at the end of the scout-daily drain loop.

## Files
- `supabase/functions/scout-daily/index.ts` — add `scan_presale` queue + drain loop + outreach tick.
- Cron insert via the insert tool (not a migration).

## Out of scope
- No changes to scan-sources / scan-external-sources / scan-presale logic — they're working now.
- No revival of any sub-minute or sub-hour cron.
- No new tables, no new caps (current daily ceiling stays at 1,300 credits).

## Expected outcome
- One cron fires at 07:00 UTC daily.
- It queues fresh scan jobs, then quietly drains them over ~10–20 minutes.
- Nothing else runs in between. Daily Firecrawl burn bounded by the existing caps.
