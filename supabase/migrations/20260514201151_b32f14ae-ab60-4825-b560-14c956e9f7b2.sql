UPDATE public.pipeline_jobs
   SET status = 'retry', locked_at = NULL, locked_by = NULL, run_after = now()
 WHERE status = 'running' AND locked_at < now() - interval '15 minutes';

INSERT INTO public.pipeline_jobs (kind, lead_id, priority, status)
SELECT 'seller_discovery', l.id, 50, 'queued'
  FROM public.leads l
 WHERE l.tier <> 'DISQUALIFIED'
   AND l.has_outreach_contact = false
   AND l.pipeline_stage <> 'disqualified'
   AND NOT EXISTS (
     SELECT 1 FROM public.pipeline_jobs j
      WHERE j.lead_id = l.id AND j.kind = 'seller_discovery' AND j.status IN ('queued','retry','running')
   );