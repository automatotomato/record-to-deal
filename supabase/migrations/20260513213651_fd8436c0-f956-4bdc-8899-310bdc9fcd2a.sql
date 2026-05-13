-- 1) Add new lead columns
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS qualification_reason text,
  ADD COLUMN IF NOT EXISTS has_contact boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_outreach_contact boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS days_since_sale int;

-- 2) New tier values
ALTER TYPE public.lead_tier ADD VALUE IF NOT EXISTS 'CRITICAL';
ALTER TYPE public.lead_tier ADD VALUE IF NOT EXISTS 'ACTIVE';
ALTER TYPE public.lead_tier ADD VALUE IF NOT EXISTS 'FOLLOW_UP';
ALTER TYPE public.lead_tier ADD VALUE IF NOT EXISTS 'EXPIRED';

-- 3) Drop ATTOM column on counties (no longer used)
ALTER TABLE public.counties DROP COLUMN IF EXISTS attom_geo_id;

-- 4) Pipeline jobs queue
CREATE TABLE IF NOT EXISTS public.pipeline_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued',
  priority int NOT NULL DEFAULT 100,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  result jsonb,
  lead_id uuid,
  county_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS pipeline_jobs_dispatch_idx
  ON public.pipeline_jobs (kind, status, run_after, priority);
CREATE INDEX IF NOT EXISTS pipeline_jobs_lead_idx
  ON public.pipeline_jobs (lead_id);

ALTER TABLE public.pipeline_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read pipeline_jobs"
  ON public.pipeline_jobs FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins manage pipeline_jobs"
  ON public.pipeline_jobs FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

-- 5) Atomic claim_jobs: lock + return up to N pending jobs of a kind
CREATE OR REPLACE FUNCTION public.claim_jobs(
  p_kind text,
  p_limit int,
  p_lock_id text
) RETURNS SETOF public.pipeline_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT id
    FROM public.pipeline_jobs
    WHERE kind = p_kind
      AND status IN ('queued', 'retry')
      AND run_after <= now()
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
$$;

REVOKE ALL ON FUNCTION public.claim_jobs(text, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_jobs(text, int, text) TO service_role;