-- Make all tables fully accessible to any authenticated user
-- Drop old admin-only policies first, then create new open ones

-- outreach_sequences
DROP POLICY IF EXISTS "Admins manage sequences" ON public.outreach_sequences;
CREATE POLICY "Authenticated users manage sequences"
ON public.outreach_sequences
FOR ALL
TO authenticated
USING (true)
WITH CHECK (true);

-- outreach_steps
DROP POLICY IF EXISTS "Admins manage outreach_steps" ON public.outreach_steps;
CREATE POLICY "Authenticated users manage outreach_steps"
ON public.outreach_steps
FOR ALL
TO authenticated
USING (true)
WITH CHECK (true);

-- counties
DROP POLICY IF EXISTS "Admins manage counties" ON public.counties;
CREATE POLICY "Authenticated users manage counties"
ON public.counties
FOR ALL
TO authenticated
USING (true)
WITH CHECK (true);

-- state_tax_rates
DROP POLICY IF EXISTS "Admins manage state_tax_rates" ON public.state_tax_rates;
CREATE POLICY "Authenticated users manage state_tax_rates"
ON public.state_tax_rates
FOR ALL
TO authenticated
USING (true)
WITH CHECK (true);

-- pipeline_jobs
DROP POLICY IF EXISTS "Admins manage pipeline_jobs" ON public.pipeline_jobs;
CREATE POLICY "Authenticated users manage pipeline_jobs"
ON public.pipeline_jobs
FOR ALL
TO authenticated
USING (true)
WITH CHECK (true);

-- user_roles
DROP POLICY IF EXISTS "Admins manage roles" ON public.user_roles;
CREATE POLICY "Authenticated users manage roles"
ON public.user_roles
FOR ALL
TO authenticated
USING (true)
WITH CHECK (true);

-- leads
DROP POLICY IF EXISTS "Admins insert leads" ON public.leads;
DROP POLICY IF EXISTS "Admins delete leads" ON public.leads;
CREATE POLICY "Authenticated users insert leads"
ON public.leads
FOR INSERT
TO authenticated
WITH CHECK (true);
CREATE POLICY "Authenticated users delete leads"
ON public.leads
FOR DELETE
TO authenticated
USING (true);
