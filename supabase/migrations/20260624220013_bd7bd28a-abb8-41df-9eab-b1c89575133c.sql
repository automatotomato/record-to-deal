-- Release jobs locked >30 min ago by a dispatcher that died.
UPDATE public.pipeline_jobs
SET status = 'queued',
    locked_at = NULL,
    locked_by = NULL,
    attempts = GREATEST(attempts - 1, 0),
    run_after = now()
WHERE status = 'running'
  AND locked_at < now() - interval '15 minutes';

-- Kick off a fresh scout cycle with the new strategy.
SELECT public.run_scout_cron();