
CREATE TABLE public.system_settings (
  id boolean PRIMARY KEY DEFAULT true,
  paused boolean NOT NULL DEFAULT false,
  paused_at timestamptz,
  paused_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT system_settings_singleton CHECK (id = true)
);
GRANT SELECT ON public.system_settings TO authenticated;
GRANT ALL ON public.system_settings TO service_role;
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff read settings" ON public.system_settings FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "staff write settings" ON public.system_settings FOR ALL TO authenticated USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));

CREATE TABLE public.paused_cron_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jobname text NOT NULL,
  schedule text NOT NULL,
  command text NOT NULL,
  paused_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.paused_cron_jobs TO authenticated;
GRANT ALL ON public.paused_cron_jobs TO service_role;
ALTER TABLE public.paused_cron_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff read paused cron" ON public.paused_cron_jobs FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

INSERT INTO public.system_settings (id, paused, paused_at) VALUES (true, false, NULL);
