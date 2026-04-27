ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS company_website text,
  ADD COLUMN IF NOT EXISTS related_entities jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS discovery_confidence_by_field jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS discovery_status text NOT NULL DEFAULT 'none';

CREATE INDEX IF NOT EXISTS idx_leads_discovery_status ON public.leads(discovery_status);