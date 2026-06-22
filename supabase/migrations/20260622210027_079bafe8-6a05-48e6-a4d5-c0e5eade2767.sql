
ALTER TABLE public.counties ADD COLUMN IF NOT EXISTS recorder_index_url text;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS entity_principals jsonb;

-- Seed recorder URLs for counties known to have free public deed search
UPDATE public.counties SET recorder_index_url = 'https://taxofficesearch.traviscountytx.gov/' WHERE state='TX' AND county='Travis';
UPDATE public.counties SET recorder_index_url = 'https://recorder.maricopa.gov/recdocdata/' WHERE state='AZ' AND county='Maricopa';
UPDATE public.counties SET recorder_index_url = 'https://onlineservices.miamidadeclerk.gov/officialrecords/StandardSearch.aspx' WHERE state='FL' AND county='Miami-Dade';
UPDATE public.counties SET recorder_index_url = 'https://or.occompt.com/recordsearch/' WHERE state='FL' AND county='Orange';
UPDATE public.counties SET recorder_index_url = 'https://officialrecords.broward.org/AcclaimWeb/' WHERE state='FL' AND county='Broward';
UPDATE public.counties SET recorder_index_url = 'https://pubrec3.hillsclerk.com/oncoreweb/' WHERE state='FL' AND county='Hillsborough';
UPDATE public.counties SET recorder_index_url = 'https://www16.hennepin.us/RecorderEsearch/' WHERE state='MN' AND county='Hennepin';
UPDATE public.counties SET recorder_index_url = 'https://recordings.multco.us/recordings/' WHERE state='OR' AND county='Multnomah';
UPDATE public.counties SET recorder_index_url = 'https://recorder.pima.gov/' WHERE state='AZ' AND county='Pima';
UPDATE public.counties SET recorder_index_url = 'https://recorder.slco.org/recorder/' WHERE state='UT' AND county='Salt Lake';
UPDATE public.counties SET recorder_index_url = 'https://recorderapps.clarkcountynv.gov/RecorderEcommerce/' WHERE state='NV' AND county='Clark';
UPDATE public.counties SET recorder_index_url = 'https://nvwashoe-trueautomation.com/recorder/' WHERE state='NV' AND county='Washoe';

-- Park any remaining enabled counties without a recorder URL
UPDATE public.counties
SET enabled = false,
    notes = COALESCE(NULLIF(notes,''), '') ||
            CASE WHEN COALESCE(notes,'') = '' THEN '' ELSE E'\n' END ||
            'Parked ' || to_char(now(), 'YYYY-MM-DD') ||
            ': awaiting free public recorder index URL or paid bulk source.'
WHERE enabled = true AND recorder_index_url IS NULL;
