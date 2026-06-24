
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS decision_maker_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS decision_maker_verification_source text,
  ADD COLUMN IF NOT EXISTS second_pass_ran boolean NOT NULL DEFAULT false;
