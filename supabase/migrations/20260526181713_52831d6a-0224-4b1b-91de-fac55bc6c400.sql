
CREATE OR REPLACE VIEW public.lead_owner_rollup AS
SELECT
  upper(regexp_replace(coalesce(owner_name,''), '[\s\.,]+', ' ', 'g')) AS owner_key,
  max(owner_name) AS owner_name_display,
  count(*) AS property_count,
  sum(coalesce(sale_price, 0)) AS total_sale_value,
  sum(coalesce(total_tax_exposure, 0)) AS total_tax_exposure,
  max(sale_date) AS latest_sale_date
FROM public.leads
WHERE owner_name IS NOT NULL
  AND length(trim(owner_name)) > 0
  AND tier NOT IN ('DISQUALIFIED','EXPIRED')
GROUP BY 1
HAVING count(*) >= 2;

GRANT SELECT ON public.lead_owner_rollup TO authenticated;
GRANT SELECT ON public.lead_owner_rollup TO service_role;
