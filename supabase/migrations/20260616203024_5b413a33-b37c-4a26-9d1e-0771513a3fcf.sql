
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS mailing_address text,
  ADD COLUMN IF NOT EXISTS mailing_city text,
  ADD COLUMN IF NOT EXISTS mailing_state text,
  ADD COLUMN IF NOT EXISTS mailing_zip text,
  ADD COLUMN IF NOT EXISTS market_value bigint,
  ADD COLUMN IF NOT EXISTS year_built integer,
  ADD COLUMN IF NOT EXISTS lot_size_sqft integer,
  ADD COLUMN IF NOT EXISTS building_sqft integer,
  ADD COLUMN IF NOT EXISTS assessor_last_sale_date date,
  ADD COLUMN IF NOT EXISTS assessor_last_sale_price bigint,
  ADD COLUMN IF NOT EXISTS owner_occupied boolean,
  ADD COLUMN IF NOT EXISTS assessor_url text,
  ADD COLUMN IF NOT EXISTS assessor_fetched_at timestamptz,
  ADD COLUMN IF NOT EXISTS assessor_status text;

COMMENT ON COLUMN public.leads.assessor_status IS 'pending | ok | not_found | unsupported_county | error';
