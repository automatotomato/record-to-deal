ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS prior_owner_name text,
  ADD COLUMN IF NOT EXISTS document_type text,
  ADD COLUMN IF NOT EXISTS recording_number text,
  ADD COLUMN IF NOT EXISTS deed_source_url text,
  ADD COLUMN IF NOT EXISTS unmask_status text,
  ADD COLUMN IF NOT EXISTS unmask_source text;

CREATE INDEX IF NOT EXISTS leads_state_county_recorded_idx
  ON public.leads (state, county, deed_date DESC);

UPDATE public.leads
   SET discovery_status = 'stale_source'
 WHERE discovery_status IS DISTINCT FROM 'stale_source'
   AND source_record_url ~* '(loopnet|crexi|costar|zillow|realtor\.com|bizbuysell|auction\.com|trulia|redfin|homes\.com|movoto)';