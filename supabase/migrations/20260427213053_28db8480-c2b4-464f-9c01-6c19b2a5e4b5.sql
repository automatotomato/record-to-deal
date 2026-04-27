-- Expand scout coverage to additional metro counties
-- Update existing LA row to use the new parser key and enable it
UPDATE public.counties SET parser_key = 'ca_los_angeles', enabled = true WHERE state = 'CA' AND county = 'Los Angeles';

-- Insert new metro counties
INSERT INTO public.counties (state, county, parser_key, enabled) VALUES
  ('AZ', 'Maricopa', 'az_maricopa', true),
  ('AZ', 'Pima', 'az_pima', true),
  ('CA', 'Orange', 'ca_orange', true),
  ('CA', 'San Diego', 'ca_san_diego', true),
  ('CA', 'Riverside', 'ca_riverside', true),
  ('TX', 'Harris', 'tx_harris', true),
  ('TX', 'Dallas', 'tx_dallas', true),
  ('TX', 'Travis', 'tx_travis', true),
  ('TX', 'Bexar', 'tx_bexar', true),
  ('FL', 'Miami-Dade', 'fl_miami_dade', true),
  ('FL', 'Broward', 'fl_broward', true),
  ('FL', 'Orange', 'fl_orange', true),
  ('FL', 'Hillsborough', 'fl_hillsborough', true),
  ('CO', 'Denver', 'co_denver', true),
  ('CO', 'Arapahoe', 'co_arapahoe', true),
  ('UT', 'Salt Lake', 'ut_salt_lake', true),
  ('WA', 'King', 'wa_king', true);