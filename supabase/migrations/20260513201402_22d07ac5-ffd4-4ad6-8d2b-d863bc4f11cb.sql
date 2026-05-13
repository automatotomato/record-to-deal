
-- 1. Counties priority
ALTER TABLE public.counties
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('high','normal','low'));

CREATE INDEX IF NOT EXISTS idx_counties_priority ON public.counties (priority, enabled);

-- 2. Lead pipeline + tax fields
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS pipeline_stage text NOT NULL DEFAULT 'discovered',
  ADD COLUMN IF NOT EXISTS state_tax_rate numeric,
  ADD COLUMN IF NOT EXISTS fed_capital_gains_estimate bigint,
  ADD COLUMN IF NOT EXISTS state_capital_gains_estimate bigint;

CREATE INDEX IF NOT EXISTS idx_leads_pipeline_stage ON public.leads (pipeline_stage);

-- 3. State tax rates table
CREATE TABLE IF NOT EXISTS public.state_tax_rates (
  state text PRIMARY KEY,
  state_name text NOT NULL,
  ltcg_rate numeric NOT NULL DEFAULT 0,
  surcharge numeric NOT NULL DEFAULT 0,
  notes text,
  is_high_tax boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.state_tax_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read state_tax_rates" ON public.state_tax_rates;
CREATE POLICY "Authenticated read state_tax_rates"
  ON public.state_tax_rates FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Admins manage state_tax_rates" ON public.state_tax_rates;
CREATE POLICY "Admins manage state_tax_rates"
  ON public.state_tax_rates FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER trg_state_tax_rates_touch
  BEFORE UPDATE ON public.state_tax_rates
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Seed published 2025 top-bracket LTCG rates (state portion only, federal handled separately)
INSERT INTO public.state_tax_rates (state, state_name, ltcg_rate, surcharge, is_high_tax, notes) VALUES
  ('CA','California',0.133,0,true,'Top bracket; treats LTCG as ordinary income'),
  ('NY','New York',0.109,0.039,true,'State 10.9% + NYC ~3.9% surcharge'),
  ('NJ','New Jersey',0.1075,0,true,'Top bracket'),
  ('OR','Oregon',0.099,0,true,'Top bracket'),
  ('MN','Minnesota',0.0985,0,true,'Top bracket'),
  ('HI','Hawaii',0.0725,0,true,'LTCG capped at 7.25%'),
  ('MA','Massachusetts',0.05,0.04,true,'5% + 4% millionaires surtax'),
  ('CT','Connecticut',0.0699,0,true,'Top bracket'),
  ('VT','Vermont',0.0875,0,true,'Top bracket'),
  ('MD','Maryland',0.0575,0.032,true,'State + avg county'),
  ('DC','District of Columbia',0.1075,0,true,'Top bracket'),
  ('IL','Illinois',0.0495,0,false,'Flat'),
  ('FL','Florida',0,0,false,'No state income tax'),
  ('TX','Texas',0,0,false,'No state income tax'),
  ('NV','Nevada',0,0,false,'No state income tax'),
  ('WA','Washington',0.07,0,false,'7% on LTCG above ~$270k'),
  ('AZ','Arizona',0.025,0,false,'Flat 2.5%'),
  ('CO','Colorado',0.044,0,false,'Flat 4.4%'),
  ('UT','Utah',0.0455,0,false,'Flat'),
  ('GA','Georgia',0.0539,0,false,'Top bracket'),
  ('NC','North Carolina',0.045,0,false,'Flat'),
  ('VA','Virginia',0.0575,0,false,'Top bracket'),
  ('PA','Pennsylvania',0.0307,0,false,'Flat'),
  ('OH','Ohio',0.035,0,false,'Top bracket'),
  ('MI','Michigan',0.0425,0,false,'Flat')
ON CONFLICT (state) DO UPDATE SET
  state_name = EXCLUDED.state_name,
  ltcg_rate = EXCLUDED.ltcg_rate,
  surcharge = EXCLUDED.surcharge,
  is_high_tax = EXCLUDED.is_high_tax,
  notes = EXCLUDED.notes;

-- 4. Re-prioritize existing counties: NV down, high-tax states up
UPDATE public.counties SET priority = 'low', enabled = false WHERE state = 'NV';
UPDATE public.counties SET priority = 'high' WHERE state IN ('CA','NY','NJ','OR','MN','MA','HI','IL');
UPDATE public.counties SET priority = 'normal' WHERE state IN ('FL','TX','CO','WA','UT','AZ');

-- 5. Add high-priority counties the client called out
INSERT INTO public.counties (state, county, parser_key, enabled, priority) VALUES
  ('CA','San Francisco','ca_san_francisco',true,'high'),
  ('CA','Alameda','ca_alameda',true,'high'),
  ('CA','Santa Clara','ca_santa_clara',true,'high'),
  ('CA','San Mateo','ca_san_mateo',true,'high'),
  ('CA','Sacramento','ca_sacramento',true,'high'),
  ('NY','Kings','ny_kings',true,'high'),
  ('NY','Queens','ny_queens',true,'high'),
  ('NY','Bronx','ny_bronx',true,'high'),
  ('NY','Westchester','ny_westchester',true,'high'),
  ('NY','Nassau','ny_nassau',true,'high'),
  ('NY','Suffolk','ny_suffolk',true,'high'),
  ('NJ','Hudson','nj_hudson',true,'high'),
  ('NJ','Essex','nj_essex',true,'high'),
  ('NJ','Middlesex','nj_middlesex',true,'high'),
  ('NJ','Monmouth','nj_monmouth',true,'high'),
  ('OR','Washington','or_washington',true,'high'),
  ('OR','Clackamas','or_clackamas',true,'high'),
  ('MN','Hennepin','mn_hennepin',true,'high'),
  ('MN','Ramsey','mn_ramsey',true,'high'),
  ('MA','Suffolk','ma_suffolk',true,'high'),
  ('MA','Norfolk','ma_norfolk',true,'high'),
  ('HI','Honolulu','hi_honolulu',true,'high'),
  ('IL','DuPage','il_dupage',true,'high'),
  ('IL','Lake','il_lake',true,'high')
ON CONFLICT DO NOTHING;

-- 6. Backfill pipeline_stage from current state
UPDATE public.leads SET pipeline_stage = 'scored'   WHERE tier <> 'UNSCORED' AND pipeline_stage = 'discovered';
UPDATE public.leads SET pipeline_stage = 'profiled' WHERE profiler_summary IS NOT NULL AND pipeline_stage IN ('discovered','scored');
UPDATE public.leads SET pipeline_stage = 'enriched' WHERE (decision_maker_email IS NOT NULL OR contact_email IS NOT NULL) AND pipeline_stage <> 'ready';
