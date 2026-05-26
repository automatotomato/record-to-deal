WITH stale AS (
  SELECT id FROM public.leads
  WHERE pipeline_stage = 'disqualified'
     OR tier IN ('DISQUALIFIED', 'EXPIRED')
     OR (sale_date IS NOT NULL AND sale_date < current_date - INTERVAL '90 days'
         AND pipeline_stage <> 'pre_sale_prospect')
)
DELETE FROM public.lead_activities WHERE lead_id IN (SELECT id FROM stale);

WITH stale AS (
  SELECT id FROM public.leads
  WHERE pipeline_stage = 'disqualified'
     OR tier IN ('DISQUALIFIED', 'EXPIRED')
     OR (sale_date IS NOT NULL AND sale_date < current_date - INTERVAL '90 days'
         AND pipeline_stage <> 'pre_sale_prospect')
)
DELETE FROM public.lead_touchpoints WHERE lead_id IN (SELECT id FROM stale);

WITH stale AS (
  SELECT id FROM public.leads
  WHERE pipeline_stage = 'disqualified'
     OR tier IN ('DISQUALIFIED', 'EXPIRED')
     OR (sale_date IS NOT NULL AND sale_date < current_date - INTERVAL '90 days'
         AND pipeline_stage <> 'pre_sale_prospect')
)
DELETE FROM public.outreach_touches WHERE lead_id IN (SELECT id FROM stale);

WITH stale AS (
  SELECT id FROM public.leads
  WHERE pipeline_stage = 'disqualified'
     OR tier IN ('DISQUALIFIED', 'EXPIRED')
     OR (sale_date IS NOT NULL AND sale_date < current_date - INTERVAL '90 days'
         AND pipeline_stage <> 'pre_sale_prospect')
)
DELETE FROM public.outreach_emails WHERE lead_id IN (SELECT id FROM stale);

WITH stale AS (
  SELECT id FROM public.leads
  WHERE pipeline_stage = 'disqualified'
     OR tier IN ('DISQUALIFIED', 'EXPIRED')
     OR (sale_date IS NOT NULL AND sale_date < current_date - INTERVAL '90 days'
         AND pipeline_stage <> 'pre_sale_prospect')
)
DELETE FROM public.pipeline_jobs WHERE lead_id IN (SELECT id FROM stale);

DELETE FROM public.leads
WHERE pipeline_stage = 'disqualified'
   OR tier IN ('DISQUALIFIED', 'EXPIRED')
   OR (sale_date IS NOT NULL AND sale_date < current_date - INTERVAL '90 days'
       AND pipeline_stage <> 'pre_sale_prospect');