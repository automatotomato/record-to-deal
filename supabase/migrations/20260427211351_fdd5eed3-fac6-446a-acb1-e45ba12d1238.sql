ALTER TABLE public.counties ADD COLUMN IF NOT EXISTS attom_geo_id text;
ALTER TABLE public.scout_runs ADD COLUMN IF NOT EXISTS leads_updated integer NOT NULL DEFAULT 0;