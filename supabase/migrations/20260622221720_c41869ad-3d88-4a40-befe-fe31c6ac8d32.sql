-- Firecrawl usage ledger + reservation gate (5 concurrent, 5000 credits/month).

CREATE TABLE IF NOT EXISTS public.firecrawl_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caller text NOT NULL,
  estimated_credits int NOT NULL DEFAULT 1,
  actual_credits int,
  status text NOT NULL DEFAULT 'in_flight', -- in_flight | done | failed | throttled
  started_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  note text
);

GRANT SELECT ON public.firecrawl_usage TO authenticated;
GRANT ALL ON public.firecrawl_usage TO service_role;

ALTER TABLE public.firecrawl_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "staff can read fc usage"
  ON public.firecrawl_usage FOR SELECT
  TO authenticated
  USING (public.is_staff(auth.uid()));

CREATE INDEX IF NOT EXISTS firecrawl_usage_inflight_idx
  ON public.firecrawl_usage (status) WHERE status = 'in_flight';
CREATE INDEX IF NOT EXISTS firecrawl_usage_started_idx
  ON public.firecrawl_usage (started_at);

-- Auto-expire orphaned reservations after 2 minutes so a crashed function
-- can't permanently consume a concurrency slot.
CREATE OR REPLACE FUNCTION public.fc_reserve(p_caller text, p_credits int)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inflight int;
  v_month_used int;
  v_id uuid;
  v_max_concurrent int := 5;
  v_monthly_cap int := 5000;
BEGIN
  -- Reap stale in-flight rows (>2 min old).
  UPDATE public.firecrawl_usage
     SET status = 'failed', released_at = now(), note = COALESCE(note, '') || ' [reaped]'
   WHERE status = 'in_flight' AND started_at < now() - interval '2 minutes';

  SELECT count(*) INTO v_inflight
    FROM public.firecrawl_usage WHERE status = 'in_flight';

  IF v_inflight >= v_max_concurrent THEN
    INSERT INTO public.firecrawl_usage (caller, estimated_credits, status, released_at, note)
    VALUES (p_caller, p_credits, 'throttled', now(), 'concurrency cap');
    RETURN NULL;
  END IF;

  SELECT COALESCE(sum(COALESCE(actual_credits, estimated_credits)), 0) INTO v_month_used
    FROM public.firecrawl_usage
   WHERE started_at >= date_trunc('month', now())
     AND status IN ('in_flight', 'done');

  IF v_month_used + p_credits > v_monthly_cap THEN
    INSERT INTO public.firecrawl_usage (caller, estimated_credits, status, released_at, note)
    VALUES (p_caller, p_credits, 'throttled', now(), 'monthly cap');
    RETURN NULL;
  END IF;

  INSERT INTO public.firecrawl_usage (caller, estimated_credits)
  VALUES (p_caller, GREATEST(p_credits, 1))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fc_release(p_id uuid, p_actual int, p_status text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.firecrawl_usage
     SET actual_credits = COALESCE(p_actual, estimated_credits),
         status = COALESCE(p_status, 'done'),
         released_at = now()
   WHERE id = p_id;
$$;

GRANT EXECUTE ON FUNCTION public.fc_reserve(text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.fc_release(uuid, int, text) TO service_role;