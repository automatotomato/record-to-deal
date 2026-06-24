
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS days_until_45_deadline integer,
  ADD COLUMN IF NOT EXISTS days_until_180_deadline integer;

ALTER TABLE public.state_tax_rates
  ADD COLUMN IF NOT EXISTS city_surcharges jsonb NOT NULL DEFAULT '{}'::jsonb;
