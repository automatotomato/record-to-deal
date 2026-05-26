
-- Helper: is the current user staff (admin or agent)?
CREATE OR REPLACE FUNCTION public.is_staff(_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role IN ('admin','agent')
  )
$$;

REVOKE EXECUTE ON FUNCTION public.is_staff(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM anon;

-- user_roles: lock down management to admins only
DROP POLICY IF EXISTS "Authenticated users manage roles" ON public.user_roles;
CREATE POLICY "Admins insert roles" ON public.user_roles FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins update roles" ON public.user_roles FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins delete roles" ON public.user_roles FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- profiles: own profile or admin
DROP POLICY IF EXISTS "Authenticated can read profiles" ON public.profiles;
CREATE POLICY "Users read own profile or admin reads all" ON public.profiles FOR SELECT TO authenticated
  USING (auth.uid() = id OR public.has_role(auth.uid(), 'admin'));

-- leads: staff only
DROP POLICY IF EXISTS "Authenticated read leads" ON public.leads;
DROP POLICY IF EXISTS "Authenticated update leads" ON public.leads;
DROP POLICY IF EXISTS "Authenticated users insert leads" ON public.leads;
DROP POLICY IF EXISTS "Authenticated users delete leads" ON public.leads;
CREATE POLICY "Staff read leads" ON public.leads FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff insert leads" ON public.leads FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));
CREATE POLICY "Staff update leads" ON public.leads FOR UPDATE TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Admins delete leads" ON public.leads FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- lead_activities: staff only
DROP POLICY IF EXISTS "Authenticated read activities" ON public.lead_activities;
DROP POLICY IF EXISTS "Authenticated insert activities" ON public.lead_activities;
CREATE POLICY "Staff read activities" ON public.lead_activities FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff insert activities" ON public.lead_activities FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));

-- lead_touchpoints: staff only
DROP POLICY IF EXISTS "Authenticated read touchpoints" ON public.lead_touchpoints;
DROP POLICY IF EXISTS "Authenticated insert own touchpoints" ON public.lead_touchpoints;
CREATE POLICY "Staff read touchpoints" ON public.lead_touchpoints FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff insert own touchpoints" ON public.lead_touchpoints FOR INSERT TO authenticated
  WITH CHECK (public.is_staff(auth.uid()) AND (user_id = auth.uid() OR user_id IS NULL));

-- outreach_emails: staff only
DROP POLICY IF EXISTS "Authenticated read emails" ON public.outreach_emails;
DROP POLICY IF EXISTS "Authenticated write emails" ON public.outreach_emails;
DROP POLICY IF EXISTS "Authenticated update emails" ON public.outreach_emails;
CREATE POLICY "Staff read emails" ON public.outreach_emails FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff insert emails" ON public.outreach_emails FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));
CREATE POLICY "Staff update emails" ON public.outreach_emails FOR UPDATE TO authenticated USING (public.is_staff(auth.uid()));

-- outreach_touches: staff only
DROP POLICY IF EXISTS "Authenticated read touches" ON public.outreach_touches;
DROP POLICY IF EXISTS "Authenticated insert touches" ON public.outreach_touches;
DROP POLICY IF EXISTS "Authenticated update touches" ON public.outreach_touches;
CREATE POLICY "Staff read touches" ON public.outreach_touches FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff insert touches" ON public.outreach_touches FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));
CREATE POLICY "Staff update touches" ON public.outreach_touches FOR UPDATE TO authenticated USING (public.is_staff(auth.uid()));

-- counties: staff read, admin write
DROP POLICY IF EXISTS "Authenticated read counties" ON public.counties;
DROP POLICY IF EXISTS "Authenticated users manage counties" ON public.counties;
CREATE POLICY "Staff read counties" ON public.counties FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Admins manage counties" ON public.counties FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- outreach_sequences: staff read, admin write
DROP POLICY IF EXISTS "Authenticated read sequences" ON public.outreach_sequences;
DROP POLICY IF EXISTS "Authenticated users manage sequences" ON public.outreach_sequences;
CREATE POLICY "Staff read sequences" ON public.outreach_sequences FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Admins manage sequences" ON public.outreach_sequences FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- outreach_steps: staff read, admin write
DROP POLICY IF EXISTS "Authenticated read outreach_steps" ON public.outreach_steps;
DROP POLICY IF EXISTS "Authenticated users manage outreach_steps" ON public.outreach_steps;
CREATE POLICY "Staff read outreach_steps" ON public.outreach_steps FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Admins manage outreach_steps" ON public.outreach_steps FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- pipeline_jobs: staff read, admin write
DROP POLICY IF EXISTS "Authenticated read pipeline_jobs" ON public.pipeline_jobs;
DROP POLICY IF EXISTS "Authenticated users manage pipeline_jobs" ON public.pipeline_jobs;
CREATE POLICY "Staff read pipeline_jobs" ON public.pipeline_jobs FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Admins manage pipeline_jobs" ON public.pipeline_jobs FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- scout_runs: staff read, admin write
DROP POLICY IF EXISTS "Authenticated read runs" ON public.scout_runs;
DROP POLICY IF EXISTS "Authenticated insert runs" ON public.scout_runs;
DROP POLICY IF EXISTS "Authenticated update runs" ON public.scout_runs;
CREATE POLICY "Staff read runs" ON public.scout_runs FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Admins insert runs" ON public.scout_runs FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins update runs" ON public.scout_runs FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- state_tax_rates: staff read, admin write
DROP POLICY IF EXISTS "Authenticated read state_tax_rates" ON public.state_tax_rates;
DROP POLICY IF EXISTS "Authenticated users manage state_tax_rates" ON public.state_tax_rates;
CREATE POLICY "Staff read state_tax_rates" ON public.state_tax_rates FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Admins manage state_tax_rates" ON public.state_tax_rates FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
