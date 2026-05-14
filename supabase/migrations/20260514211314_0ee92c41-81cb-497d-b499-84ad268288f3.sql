-- 1. state_tax_rates: priority + target flag
ALTER TABLE public.state_tax_rates
  ADD COLUMN IF NOT EXISTS priority_rank INTEGER NOT NULL DEFAULT 99,
  ADD COLUMN IF NOT EXISTS is_target BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_state_tax_rates_priority ON public.state_tax_rates(priority_rank);

-- 2. leads: profiler, wealth, sequence tracking
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS wealth_tier TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS effective_tax_rate NUMERIC,
  ADD COLUMN IF NOT EXISTS actual_capital_gain BIGINT,
  ADD COLUMN IF NOT EXISTS outreach_sequence_id UUID,
  ADD COLUMN IF NOT EXISTS outreach_step_index INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS outreach_next_step_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_leads_outreach_next ON public.leads(outreach_next_step_at)
  WHERE outreach_next_step_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_wealth_tier ON public.leads(wealth_tier);

-- 3. outreach_sequences (named cadences)
CREATE TABLE IF NOT EXISTS public.outreach_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  audience TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.outreach_sequences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read sequences" ON public.outreach_sequences
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins manage sequences" ON public.outreach_sequences
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER touch_outreach_sequences_updated_at
  BEFORE UPDATE ON public.outreach_sequences
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 4. outreach_steps (per-step config)
CREATE TABLE IF NOT EXISTS public.outreach_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID NOT NULL REFERENCES public.outreach_sequences(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  channel TEXT NOT NULL,
  delay_days INTEGER NOT NULL DEFAULT 0,
  template_key TEXT NOT NULL,
  branch_condition TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sequence_id, step_index)
);

ALTER TABLE public.outreach_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read outreach_steps" ON public.outreach_steps
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins manage outreach_steps" ON public.outreach_steps
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX IF NOT EXISTS idx_outreach_steps_seq ON public.outreach_steps(sequence_id, step_index);

-- 5. outreach_touches (executed step log)
CREATE TABLE IF NOT EXISTS public.outreach_touches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  sequence_id UUID NOT NULL,
  step_index INTEGER NOT NULL,
  channel TEXT NOT NULL,
  template_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'drafted',
  outreach_email_id UUID,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.outreach_touches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read touches" ON public.outreach_touches
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated insert touches" ON public.outreach_touches
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated update touches" ON public.outreach_touches
  FOR UPDATE TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_outreach_touches_lead ON public.outreach_touches(lead_id, step_index);

CREATE TRIGGER touch_outreach_touches_updated_at
  BEFORE UPDATE ON public.outreach_touches
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();