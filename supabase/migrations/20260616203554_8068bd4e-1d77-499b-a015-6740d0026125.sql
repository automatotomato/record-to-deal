
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Plan + enqueue scout jobs. Mirrors the run-scout edge function logic but in
-- plpgsql so pg_cron can call it without needing any HTTP credentials.
CREATE OR REPLACE FUNCTION public.run_scout_cron()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id uuid;
  v_inserted_sources int := 0;
  v_inserted_county int := 0;
  v_inserted_external int := 0;
  v_county record;
BEGIN
  -- Hard rate limit: skip if a cron scout_run started in the last 10 minutes.
  IF EXISTS (
    SELECT 1 FROM public.scout_runs
    WHERE trigger_kind = 'cron'
      AND started_at > now() - interval '10 minutes'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'skipped', 'rate_limited');
  END IF;

  INSERT INTO public.scout_runs (trigger_kind, status, counties_scanned)
  VALUES ('cron', 'running', 0)
  RETURNING id INTO v_run_id;

  -- Per enabled county: enqueue scan_county if Travis (adapter), else scan_sources.
  -- Dedupes against any queued/retry/running job for the same (kind, county).
  FOR v_county IN
    SELECT c.id, c.state, c.county
    FROM public.counties c
    WHERE c.enabled = true
  LOOP
    IF lower(v_county.state) = 'tx' AND lower(regexp_replace(v_county.county, '\s+county$', '', 'i')) = 'travis' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.pipeline_jobs
        WHERE kind = 'scan_county' AND county_id = v_county.id
          AND status IN ('queued','retry','running')
      ) THEN
        INSERT INTO public.pipeline_jobs (kind, county_id, priority, payload)
        VALUES ('scan_county', v_county.id, 50,
                jsonb_build_object('adapter_id','travis','scout_run_id', v_run_id));
        v_inserted_county := v_inserted_county + 1;
      END IF;
    ELSE
      IF NOT EXISTS (
        SELECT 1 FROM public.pipeline_jobs
        WHERE kind = 'scan_sources' AND county_id = v_county.id
          AND status IN ('queued','retry','running')
      ) THEN
        INSERT INTO public.pipeline_jobs (kind, county_id, priority, payload)
        VALUES ('scan_sources', v_county.id, 50,
                jsonb_build_object('scout_run_id', v_run_id));
        v_inserted_sources := v_inserted_sources + 1;
      END IF;
    END IF;
  END LOOP;

  -- One external scan per cron tick.
  IF NOT EXISTS (
    SELECT 1 FROM public.pipeline_jobs
    WHERE kind = 'scan_external' AND status IN ('queued','retry','running')
  ) THEN
    INSERT INTO public.pipeline_jobs (kind, priority, payload)
    VALUES ('scan_external', 50, jsonb_build_object('scout_run_id', v_run_id));
    v_inserted_external := 1;
  END IF;

  UPDATE public.scout_runs
  SET counties_scanned = v_inserted_county + v_inserted_sources,
      errors = jsonb_build_array(jsonb_build_object(
        'plan', jsonb_build_object(
          'scan_sources', v_inserted_sources,
          'scan_county',  v_inserted_county,
          'scan_external', v_inserted_external)))
  WHERE id = v_run_id;

  RETURN jsonb_build_object(
    'ok', true,
    'scout_run_id', v_run_id,
    'scan_sources', v_inserted_sources,
    'scan_county',  v_inserted_county,
    'scan_external', v_inserted_external);
END;
$$;

-- Only the scheduler / service role should be able to invoke this.
REVOKE ALL ON FUNCTION public.run_scout_cron() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_scout_cron() TO service_role, postgres;
