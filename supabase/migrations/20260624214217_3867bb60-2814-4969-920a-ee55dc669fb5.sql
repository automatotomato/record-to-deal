
-- 1) Per-lead cooldown tracking
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS last_discovery_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS discovery_attempt_count int NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_leads_discovery_cooldown
  ON public.leads (last_discovery_attempt_at)
  WHERE discovery_status IN ('partial','failed');

-- 2) Daily Firecrawl spend ledger
CREATE TABLE IF NOT EXISTS public.firecrawl_daily_budget (
  caller text NOT NULL,
  day date NOT NULL DEFAULT current_date,
  credits_used int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (caller, day)
);
GRANT SELECT ON public.firecrawl_daily_budget TO authenticated;
GRANT ALL ON public.firecrawl_daily_budget TO service_role;
ALTER TABLE public.firecrawl_daily_budget ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff can read firecrawl budget"
  ON public.firecrawl_daily_budget
  FOR SELECT
  TO authenticated
  USING (public.is_staff(auth.uid()));

-- 3) URL-level Firecrawl cache (skip re-fetches)
CREATE TABLE IF NOT EXISTS public.firecrawl_url_cache (
  url text PRIMARY KEY,
  last_fetched_at timestamptz NOT NULL DEFAULT now(),
  caller text NOT NULL,
  result_kind text NOT NULL DEFAULT 'scrape'
);
GRANT SELECT ON public.firecrawl_url_cache TO authenticated;
GRANT ALL ON public.firecrawl_url_cache TO service_role;
ALTER TABLE public.firecrawl_url_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff can read firecrawl url cache"
  ON public.firecrawl_url_cache
  FOR SELECT
  TO authenticated
  USING (public.is_staff(auth.uid()));

-- 4) Daily-cap aware reserve. Returns NULL when the caller's daily ceiling
-- would be exceeded. Existing monthly cap + concurrency cap still apply.
CREATE OR REPLACE FUNCTION public.fc_reserve_capped(p_caller text, p_credits int)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_inflight int;
  v_month_used int;
  v_today_used int;
  v_daily_cap int;
  v_id uuid;
  v_max_concurrent int := 5;
  v_monthly_cap int := 5000;
BEGIN
  v_daily_cap := CASE p_caller
    WHEN 'seller-discovery' THEN 300
    WHEN 'enrich-contact' THEN 200
    WHEN 'scan-sources' THEN 400
    WHEN 'scan-external-sources' THEN 300
    WHEN 'scan-presale' THEN 300
    WHEN 'wealth-scan' THEN 100
    ELSE 200
  END;

  -- Reap stale in-flight rows (>2 min old).
  UPDATE public.firecrawl_usage
     SET status = 'failed', released_at = now(), note = COALESCE(note,'') || ' [reaped]'
   WHERE status = 'in_flight' AND started_at < now() - interval '2 minutes';

  SELECT count(*) INTO v_inflight FROM public.firecrawl_usage WHERE status = 'in_flight';
  IF v_inflight >= v_max_concurrent THEN
    INSERT INTO public.firecrawl_usage (caller, estimated_credits, status, released_at, note)
    VALUES (p_caller, p_credits, 'throttled', now(), 'concurrency cap');
    RETURN NULL;
  END IF;

  SELECT COALESCE(credits_used, 0) INTO v_today_used
    FROM public.firecrawl_daily_budget WHERE caller = p_caller AND day = current_date;
  v_today_used := COALESCE(v_today_used, 0);
  IF v_today_used + p_credits > v_daily_cap THEN
    INSERT INTO public.firecrawl_usage (caller, estimated_credits, status, released_at, note)
    VALUES (p_caller, p_credits, 'throttled', now(), 'daily cap');
    RETURN NULL;
  END IF;

  SELECT COALESCE(sum(COALESCE(actual_credits, estimated_credits)),0) INTO v_month_used
    FROM public.firecrawl_usage
   WHERE started_at >= date_trunc('month', now()) AND status IN ('in_flight','done');
  IF v_month_used + p_credits > v_monthly_cap THEN
    INSERT INTO public.firecrawl_usage (caller, estimated_credits, status, released_at, note)
    VALUES (p_caller, p_credits, 'throttled', now(), 'monthly cap');
    RETURN NULL;
  END IF;

  INSERT INTO public.firecrawl_daily_budget (caller, day, credits_used, updated_at)
  VALUES (p_caller, current_date, p_credits, now())
  ON CONFLICT (caller, day) DO UPDATE
    SET credits_used = public.firecrawl_daily_budget.credits_used + EXCLUDED.credits_used,
        updated_at = now();

  INSERT INTO public.firecrawl_usage (caller, estimated_credits)
  VALUES (p_caller, GREATEST(p_credits,1))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- 5) Scout cron now also enqueues a daily pre-sale scan per enabled state.
CREATE OR REPLACE FUNCTION public.run_scout_cron()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_run_id uuid;
  v_inserted_sources int := 0;
  v_inserted_county int := 0;
  v_inserted_external int := 0;
  v_inserted_presale int := 0;
  v_county record;
  v_state record;
  v_source text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.scout_runs WHERE trigger_kind='cron' AND started_at > now() - interval '10 minutes') THEN
    RETURN jsonb_build_object('ok', false, 'skipped', 'rate_limited');
  END IF;
  INSERT INTO public.scout_runs (trigger_kind, status, counties_scanned) VALUES ('cron','running',0) RETURNING id INTO v_run_id;

  FOR v_county IN SELECT c.id, c.state, c.county FROM public.counties c WHERE c.enabled=true LOOP
    IF lower(v_county.state)='tx' AND lower(regexp_replace(v_county.county,'\s+county$','','i'))='travis' THEN
      IF NOT EXISTS (SELECT 1 FROM public.pipeline_jobs WHERE kind='scan_county' AND county_id=v_county.id AND status IN ('queued','retry','running')) THEN
        INSERT INTO public.pipeline_jobs (kind, county_id, priority, payload)
        VALUES ('scan_county', v_county.id, 50, jsonb_build_object('adapter_id','travis','scout_run_id', v_run_id));
        v_inserted_county := v_inserted_county + 1;
      END IF;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM public.pipeline_jobs WHERE kind='scan_sources' AND county_id=v_county.id AND status IN ('queued','retry','running')) THEN
        INSERT INTO public.pipeline_jobs (kind, county_id, priority, payload)
        VALUES ('scan_sources', v_county.id, 50, jsonb_build_object('scout_run_id', v_run_id));
        v_inserted_sources := v_inserted_sources + 1;
      END IF;
    END IF;
  END LOOP;

  FOR v_state IN SELECT DISTINCT state FROM public.counties WHERE enabled=true LOOP
    FOREACH v_source IN ARRAY ARRAY['commercial','pending_sale','recent_close','court','sec'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.pipeline_jobs
        WHERE kind='scan_external' AND status IN ('queued','retry','running')
          AND payload->>'state' = v_state.state AND payload->>'source' = v_source
      ) THEN
        INSERT INTO public.pipeline_jobs (kind, priority, payload)
        VALUES ('scan_external', 60, jsonb_build_object('state', v_state.state, 'source', v_source, 'scout_run_id', v_run_id));
        v_inserted_external := v_inserted_external + 1;
      END IF;
    END LOOP;

    -- one pre-sale scan per state per cron sweep
    IF NOT EXISTS (
      SELECT 1 FROM public.pipeline_jobs
      WHERE kind='scan_presale' AND status IN ('queued','retry','running')
        AND payload->>'state' = v_state.state
    ) THEN
      INSERT INTO public.pipeline_jobs (kind, priority, payload)
      VALUES ('scan_presale', 55, jsonb_build_object('state', v_state.state, 'scout_run_id', v_run_id));
      v_inserted_presale := v_inserted_presale + 1;
    END IF;
  END LOOP;

  UPDATE public.scout_runs
  SET counties_scanned = v_inserted_county + v_inserted_sources,
      errors = jsonb_build_array(jsonb_build_object('plan', jsonb_build_object(
        'scan_sources', v_inserted_sources,
        'scan_county', v_inserted_county,
        'scan_external', v_inserted_external,
        'scan_presale', v_inserted_presale)))
  WHERE id = v_run_id;

  RETURN jsonb_build_object(
    'ok', true, 'scout_run_id', v_run_id,
    'scan_sources', v_inserted_sources, 'scan_county', v_inserted_county,
    'scan_external', v_inserted_external, 'scan_presale', v_inserted_presale);
END;
$function$;
