-- 1) Lead enrichment + CRM fields
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS decision_maker_name text,
  ADD COLUMN IF NOT EXISTS decision_maker_role text,
  ADD COLUMN IF NOT EXISTS decision_maker_email text,
  ADD COLUMN IF NOT EXISTS decision_maker_phone text,
  ADD COLUMN IF NOT EXISTS decision_maker_linkedin text,
  ADD COLUMN IF NOT EXISTS entity_registry_url text,
  ADD COLUMN IF NOT EXISTS enrichment_confidence integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS enrichment_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS next_action text,
  ADD COLUMN IF NOT EXISTS next_action_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_touchpoint_kind text,
  ADD COLUMN IF NOT EXISTS last_touchpoint_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_leads_next_action_at ON public.leads (next_action_at);
CREATE INDEX IF NOT EXISTS idx_leads_last_touchpoint_at ON public.leads (last_touchpoint_at DESC);

-- 2) Counties: opt-in court records
ALTER TABLE public.counties
  ADD COLUMN IF NOT EXISTS court_records_enabled boolean NOT NULL DEFAULT false;

-- 3) New CRM touchpoints table
CREATE TABLE IF NOT EXISTS public.lead_touchpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  kind text NOT NULL,            -- email_sent | email_reply | call | meeting | note | linkedin_msg | sms
  direction text NOT NULL DEFAULT 'outbound', -- outbound | inbound
  subject text,
  body text,
  outcome text,                  -- no_answer | replied | left_voicemail | meeting_booked | not_interested | bad_contact | sent
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_touchpoints_lead ON public.lead_touchpoints (lead_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_touchpoints_user ON public.lead_touchpoints (user_id);

ALTER TABLE public.lead_touchpoints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read touchpoints"
  ON public.lead_touchpoints FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated insert own touchpoints"
  ON public.lead_touchpoints FOR INSERT
  TO authenticated WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "Owners or admins update touchpoints"
  ON public.lead_touchpoints FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "Owners or admins delete touchpoints"
  ON public.lead_touchpoints FOR DELETE
  TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'::public.app_role));

-- 4) Trigger: keep leads.last_touchpoint_* in sync with the most recent touchpoint
CREATE OR REPLACE FUNCTION public.sync_lead_last_touchpoint()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.leads
  SET last_touchpoint_kind = NEW.kind,
      last_touchpoint_at = NEW.occurred_at
  WHERE id = NEW.lead_id
    AND (last_touchpoint_at IS NULL OR NEW.occurred_at >= last_touchpoint_at);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_lead_last_touchpoint ON public.lead_touchpoints;
CREATE TRIGGER trg_sync_lead_last_touchpoint
AFTER INSERT ON public.lead_touchpoints
FOR EACH ROW EXECUTE FUNCTION public.sync_lead_last_touchpoint();