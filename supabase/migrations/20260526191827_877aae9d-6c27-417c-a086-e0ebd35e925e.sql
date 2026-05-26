CREATE TABLE public.client_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  category text NOT NULL DEFAULT 'general',
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_feedback TO authenticated;
GRANT ALL ON public.client_feedback TO service_role;

ALTER TABLE public.client_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone authenticated can submit feedback" ON public.client_feedback FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Anyone authenticated can view feedback" ON public.client_feedback FOR SELECT TO authenticated USING (true);
CREATE POLICY "Anyone authenticated can update feedback" ON public.client_feedback FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Anyone authenticated can delete own feedback" ON public.client_feedback FOR DELETE TO authenticated USING (true);