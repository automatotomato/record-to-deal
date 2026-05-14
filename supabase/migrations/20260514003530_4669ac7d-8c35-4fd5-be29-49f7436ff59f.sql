
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS readiness text NOT NULL DEFAULT 'researching';

CREATE OR REPLACE FUNCTION public.compute_lead_readiness()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  has_email boolean;
  has_phone boolean;
  has_owner boolean;
  has_property boolean;
  has_brief boolean;
  exhausted boolean;
BEGIN
  has_email := NEW.decision_maker_email IS NOT NULL
               AND NEW.decision_maker_email !~* 'email_not_unlocked|@domain\.com|@apollo-locked'
               AND NEW.decision_maker_email ~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$';
  has_phone := (
    (NEW.decision_maker_phone IS NOT NULL AND length(regexp_replace(NEW.decision_maker_phone, '\D', '', 'g')) >= 10)
    OR (NEW.contact_phone IS NOT NULL AND length(regexp_replace(NEW.contact_phone, '\D', '', 'g')) >= 10)
  );
  has_owner := NEW.owner_name IS NOT NULL AND length(trim(NEW.owner_name)) > 0;
  has_property := NEW.property_address IS NOT NULL AND length(trim(NEW.property_address)) > 0;
  has_brief := NEW.ai_brief IS NOT NULL
               AND (NEW.ai_brief ? 'summary' OR NEW.ai_brief ? 'why_good');
  exhausted := NEW.discovery_status IN ('failed', 'partial');

  IF NEW.tier = 'DISQUALIFIED' OR NEW.pipeline_stage = 'disqualified' THEN
    NEW.readiness := 'low_confidence';
  ELSIF (has_email OR has_phone) AND has_owner AND has_property AND has_brief THEN
    NEW.readiness := 'ready_for_outreach';
  ELSIF (has_email OR has_phone) AND has_owner AND has_property THEN
    NEW.readiness := 'contact_found';
  ELSIF exhausted AND has_owner THEN
    NEW.readiness := 'needs_manual_review';
  ELSIF has_owner AND has_property AND NEW.pipeline_stage IN ('enriched', 'needs_review', 'ready') THEN
    NEW.readiness := 'needs_contact_info';
  ELSIF NEW.score IS NOT NULL AND NEW.score < 30 THEN
    NEW.readiness := 'low_confidence';
  ELSE
    NEW.readiness := 'researching';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_compute_lead_readiness ON public.leads;
CREATE TRIGGER trg_compute_lead_readiness
  BEFORE INSERT OR UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.compute_lead_readiness();

-- Backfill: trigger recomputation for all existing rows
UPDATE public.leads SET updated_at = now();

CREATE INDEX IF NOT EXISTS idx_leads_readiness
  ON public.leads (readiness, is_urgent DESC, score DESC);
