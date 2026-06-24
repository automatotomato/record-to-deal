
-- Add dedup tracking and remove old crons
ALTER TABLE public.counties
  ADD COLUMN IF NOT EXISTS last_seen_source_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_scanned_at timestamptz;

-- Drop old overlapping crons; we'll replace with a single guarded scout-daily
DO $$
BEGIN
  PERFORM cron.unschedule('daily-scan-8am');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('run-scan-daily-7am');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- Schedule the new single daily scout (8:00 UTC). Edge function added in the same change.
SELECT cron.schedule(
  'scout-daily-8am',
  '0 8 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://bebakfrptkmjcaqursui.supabase.co/functions/v1/scout-daily',
    headers := '{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJlYmFrZnJwdGttamNhcXVyc3VpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMDQ3NjcsImV4cCI6MjA5Mjg4MDc2N30.B0gX7C0xEdOlW9pZEQ05oRUWudbzAjZlTO9Y2xV5muE"}'::jsonb,
    body := '{"trigger":"cron"}'::jsonb
  );
  $cron$
);

-- Schedule a lightweight dispatcher tick every 5 minutes (workers chain a lot of jobs; we still need them drained the same day)
DO $$
BEGIN
  PERFORM cron.unschedule('job-dispatcher-5min');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'job-dispatcher-5min',
  '*/5 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://bebakfrptkmjcaqursui.supabase.co/functions/v1/job-dispatcher',
    headers := '{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJlYmFrZnJwdGttamNhcXVyc3VpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMDQ3NjcsImV4cCI6MjA5Mjg4MDc2N30.B0gX7C0xEdOlW9pZEQ05oRUWudbzAjZlTO9Y2xV5muE"}'::jsonb,
    body := '{"trigger":"cron"}'::jsonb
  );
  $cron$
);

-- Sweeper: weekly (Sundays at 4 UTC)
DO $$
BEGIN
  PERFORM cron.unschedule('pipeline-sweeper-weekly');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'pipeline-sweeper-weekly',
  '0 4 * * 0',
  $cron$
  SELECT net.http_post(
    url := 'https://bebakfrptkmjcaqursui.supabase.co/functions/v1/pipeline-sweeper',
    headers := '{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJlYmFrZnJwdGttamNhcXVyc3VpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMDQ3NjcsImV4cCI6MjA5Mjg4MDc2N30.B0gX7C0xEdOlW9pZEQ05oRUWudbzAjZlTO9Y2xV5muE"}'::jsonb,
    body := '{"trigger":"cron"}'::jsonb
  );
  $cron$
);

-- Update claim_jobs to cap attempts at 2 (move to failed instead of retry loop)
CREATE OR REPLACE FUNCTION public.claim_jobs(p_kind text, p_limit integer, p_lock_id text)
 RETURNS SETOF pipeline_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Fail any job that's already been attempted >= 2 times and is queued/retry.
  UPDATE public.pipeline_jobs
     SET status = 'failed',
         finished_at = now(),
         last_error = COALESCE(last_error, '') || ' [attempts exhausted]'
   WHERE kind = p_kind
     AND status IN ('queued','retry')
     AND attempts >= 2;

  RETURN QUERY
  WITH picked AS (
    SELECT id
    FROM public.pipeline_jobs
    WHERE kind = p_kind
      AND status IN ('queued', 'retry')
      AND run_after <= now()
      AND attempts < 2
    ORDER BY priority ASC, run_after ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.pipeline_jobs j
     SET status = 'running',
         locked_at = now(),
         locked_by = p_lock_id,
         attempts = j.attempts + 1
    FROM picked
   WHERE j.id = picked.id
   RETURNING j.*;
END;
$function$;
