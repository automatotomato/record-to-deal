
-- ============ ENUMS ============
CREATE TYPE public.app_role AS ENUM ('admin', 'agent');
CREATE TYPE public.lead_tier AS ENUM ('URGENT', 'HOT', 'WARM', 'COLD', 'DISQUALIFIED', 'UNSCORED');
CREATE TYPE public.lead_status AS ENUM ('new', 'reviewing', 'contacted', 'replied', 'meeting', 'won', 'dead');
CREATE TYPE public.owner_type AS ENUM ('Individual', 'Joint', 'LLC', 'Trust', 'Corporation', 'Estate', 'Unknown');
CREATE TYPE public.property_type AS ENUM ('SFR', 'Multifamily', 'Commercial', 'Land', 'Mixed', 'Unknown');
CREATE TYPE public.trigger_event AS ENUM ('sale_recorded', 'pending_sale', 'listing_aged', 'commercial_listing', 'probate', 'llc_dissolution', 'divorce');
CREATE TYPE public.scout_run_status AS ENUM ('running', 'success', 'partial', 'failed');

-- ============ PROFILES ============
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read profiles" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);

-- ============ USER ROLES ============
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

CREATE POLICY "Users see own roles" ON public.user_roles FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins manage roles" ON public.user_roles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- ============ NEW USER TRIGGER (first user => admin, rest => agent) ============
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  is_first BOOLEAN;
BEGIN
  INSERT INTO public.profiles (id, email, display_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)));

  SELECT NOT EXISTS (SELECT 1 FROM public.user_roles) INTO is_first;
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, CASE WHEN is_first THEN 'admin'::public.app_role ELSE 'agent'::public.app_role END);

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============ UPDATED_AT HELPER ============
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- ============ COUNTIES ============
CREATE TABLE public.counties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT NOT NULL,
  county TEXT NOT NULL,
  source_url TEXT,
  parser_key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (state, county)
);
ALTER TABLE public.counties ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER counties_touch BEFORE UPDATE ON public.counties FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE POLICY "Authenticated read counties" ON public.counties FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins manage counties" ON public.counties FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- ============ LEADS (unified Scout + Qualifier + Profiler record) ============
CREATE TABLE public.leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SCOUT layer
  county_id UUID REFERENCES public.counties(id) ON DELETE SET NULL,
  state TEXT NOT NULL,
  county TEXT NOT NULL,
  trigger_event public.trigger_event,
  property_address TEXT,
  property_city TEXT,
  property_zip TEXT,
  property_type public.property_type DEFAULT 'Unknown',
  parcel_number TEXT,
  sale_price BIGINT,
  sale_date DATE,
  list_price BIGINT,
  list_date DATE,
  assessed_value BIGINT,
  owner_name TEXT,
  owner_type public.owner_type DEFAULT 'Unknown',
  mailing_address TEXT,
  deed_date DATE,
  ownership_years INTEGER,
  data_sources TEXT[] DEFAULT '{}',
  source_record_url TEXT,
  scout_confidence INTEGER DEFAULT 0,

  -- QUALIFIER layer
  score INTEGER DEFAULT 0,
  tier public.lead_tier NOT NULL DEFAULT 'UNSCORED',
  is_urgent BOOLEAN NOT NULL DEFAULT false,
  capital_gains_estimate BIGINT,
  depreciation_recapture_est BIGINT,
  total_tax_exposure BIGINT,
  wealth_signals JSONB DEFAULT '[]'::jsonb,
  contact_email TEXT,
  contact_phone TEXT,
  contact_linkedin TEXT,
  contact_completeness INTEGER DEFAULT 0,
  qualifier_notes TEXT,
  score_breakdown JSONB,

  -- PROFILER layer
  personality_type TEXT,
  motivation_type TEXT,
  preferred_channel TEXT,
  pitch_angle TEXT,
  lv_property_recommendation TEXT,
  profiler_summary TEXT,

  -- WORKFLOW
  status public.lead_status NOT NULL DEFAULT 'new',
  assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  last_contacted_at TIMESTAMPTZ,
  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Dedupe key: same property + same sale event shouldn't double-insert
  UNIQUE (state, county, parcel_number, sale_date)
);
CREATE INDEX leads_tier_score_idx ON public.leads (tier, score DESC);
CREATE INDEX leads_state_idx ON public.leads (state);
CREATE INDEX leads_status_idx ON public.leads (status);
CREATE INDEX leads_sale_date_idx ON public.leads (sale_date DESC);
CREATE INDEX leads_urgent_idx ON public.leads (is_urgent) WHERE is_urgent = true;

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER leads_touch BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE POLICY "Authenticated read leads" ON public.leads FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated update leads" ON public.leads FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Admins insert leads" ON public.leads FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins delete leads" ON public.leads FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- ============ LEAD ACTIVITIES (append-only audit log) ============
CREATE TABLE public.lead_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL, -- scraped, scored, profiled, drafted, sent, status_change, note
  summary TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX lead_activities_lead_idx ON public.lead_activities (lead_id, created_at DESC);
ALTER TABLE public.lead_activities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read activities" ON public.lead_activities FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated insert activities" ON public.lead_activities FOR INSERT TO authenticated WITH CHECK (true);

-- ============ OUTREACH EMAILS ============
CREATE TABLE public.outreach_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  to_email TEXT,
  drafted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  sent_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ,
  gmail_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | sent | failed
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outreach_emails_lead_idx ON public.outreach_emails (lead_id, created_at DESC);
ALTER TABLE public.outreach_emails ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER outreach_emails_touch BEFORE UPDATE ON public.outreach_emails FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE POLICY "Authenticated read emails" ON public.outreach_emails FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write emails" ON public.outreach_emails FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated update emails" ON public.outreach_emails FOR UPDATE TO authenticated USING (true);

-- ============ SCOUT RUNS ============
CREATE TABLE public.scout_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  trigger_kind TEXT NOT NULL DEFAULT 'manual', -- manual | cron
  status public.scout_run_status NOT NULL DEFAULT 'running',
  counties_scanned INTEGER DEFAULT 0,
  leads_found INTEGER DEFAULT 0,
  leads_qualified INTEGER DEFAULT 0,
  leads_profiled INTEGER DEFAULT 0,
  errors JSONB DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX scout_runs_started_idx ON public.scout_runs (started_at DESC);
ALTER TABLE public.scout_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read runs" ON public.scout_runs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated insert runs" ON public.scout_runs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated update runs" ON public.scout_runs FOR UPDATE TO authenticated USING (true);

-- ============ SEED COUNTIES ============
INSERT INTO public.counties (state, county, parser_key, source_url, notes) VALUES
  ('CA', 'Los Angeles', 'la_county', 'https://www.lavote.gov/home/recorder/recorder-property-records', 'LA County Registrar-Recorder public deed search'),
  ('IL', 'Cook', 'cook_county', 'https://crs.cookcountyclerkil.gov/', 'Cook County Recorder of Deeds public search'),
  ('NY', 'New York', 'ny_acris', 'https://a836-acris.nyc.gov/CP/', 'NYC ACRIS - not yet wired'),
  ('NJ', 'Bergen', 'nj_bergen', NULL, 'Not yet wired'),
  ('OR', 'Multnomah', 'or_multnomah', NULL, 'Not yet wired'),
  ('MA', 'Middlesex', 'ma_middlesex', NULL, 'Not yet wired')
ON CONFLICT (state, county) DO NOTHING;

-- Disable counties without parser yet
UPDATE public.counties SET enabled = false WHERE parser_key NOT IN ('la_county', 'cook_county');
