UPDATE public.leads
SET pipeline_stage = 'disqualified',
    tier = 'DISQUALIFIED',
    qualification_reason = COALESCE(qualification_reason, '') ||
      CASE WHEN qualification_reason IS NULL OR qualification_reason = '' THEN '' ELSE ' | ' END ||
      'Auto-removed: sale > 90 days (outside actionable window).',
    is_urgent = false,
    updated_at = now()
WHERE sale_date IS NOT NULL
  AND sale_date < (current_date - INTERVAL '90 days')
  AND pipeline_stage <> 'disqualified';