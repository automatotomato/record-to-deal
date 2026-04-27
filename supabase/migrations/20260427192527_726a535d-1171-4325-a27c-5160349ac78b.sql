ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS smarty_key text;
CREATE INDEX IF NOT EXISTS idx_leads_smarty_key ON public.leads(smarty_key);