CREATE OR REPLACE FUNCTION public.compute_lead_readiness()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  has_email boolean;
  has_phone boolean;
  has_owner boolean;
  has_property boolean;
  has_parcel boolean;
  has_brief boolean;
  has_human_dm boolean;
  has_verified_role boolean;
  has_price boolean;
  exhausted boolean;
  broker_domain_re text := '@(compass|kw|kellerwilliams|cbre|jll|marcusmillichap|colliers|cushmanwakefield|berkshirehathawayhs|century21|remax|coldwellbanker|sothebysrealty|douglaselliman|corcoran|exprealty|har|loopnet|crexi|zillow|realtor|redfin|trulia)\.com$';
  generic_email_re text := '^(info|contact|hello|sales|admin|office|support|noreply|no-reply)@';
  broker_owner_re text := '\b(compass|keller williams|cbre|jll|marcus.*millichap|colliers|cushman|berkshire hathaway|century 21|re/?max|coldwell banker|sotheby|douglas elliman|corcoran|exp realty)\b';
  dm_role_re text := '\b(manager|managing member|member|officer|trustee|owner|principal|president|ceo|director)\b';
BEGIN
  has_email := NEW.decision_maker_email IS NOT NULL
               AND NEW.decision_maker_email !~* 'email_not_unlocked|@domain\.com|@apollo-locked'
               AND NEW.decision_maker_email ~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'
               AND NEW.decision_maker_email !~* broker_domain_re
               AND NEW.decision_maker_email !~* generic_email_re;
  has_phone := (
    (NEW.decision_maker_phone IS NOT NULL AND length(regexp_replace(NEW.decision_maker_phone, '\D', '', 'g')) >= 10)
    OR (NEW.contact_phone IS NOT NULL AND length(regexp_replace(NEW.contact_phone, '\D', '', 'g')) >= 10)
  );
  has_owner := NEW.owner_name IS NOT NULL
               AND length(trim(NEW.owner_name)) > 0
               AND NEW.owner_name !~* broker_owner_re;
  has_property := NEW.property_address IS NOT NULL AND length(trim(NEW.property_address)) > 0;
  has_parcel := NEW.parcel_number IS NOT NULL AND length(trim(NEW.parcel_number)) > 0;
  has_brief := NEW.ai_brief IS NOT NULL
               AND (NEW.ai_brief ? 'summary' OR NEW.ai_brief ? 'why_good');
  has_human_dm := NEW.decision_maker_name IS NOT NULL
                  AND length(trim(NEW.decision_maker_name)) > 0
                  AND NEW.decision_maker_name <> NEW.owner_name
                  AND array_length(regexp_split_to_array(trim(NEW.decision_maker_name), '\s+'), 1) BETWEEN 2 AND 4;
  has_verified_role := NEW.decision_maker_role IS NOT NULL
                       AND NEW.decision_maker_role ~* dm_role_re;
  has_price := NEW.sale_price IS NOT NULL AND NEW.sale_price >= 500000;
  exhausted := NEW.discovery_status IN ('failed', 'partial');

  IF NEW.tier = 'DISQUALIFIED' OR NEW.pipeline_stage = 'disqualified' THEN
    NEW.readiness := 'low_confidence';
  ELSIF (has_email OR has_phone)
        AND has_owner AND has_property AND has_parcel AND has_price
        AND has_brief AND has_human_dm AND has_verified_role
        AND COALESCE(NEW.scout_confidence, 0) >= 70 THEN
    NEW.readiness := 'ready_for_outreach';
  ELSIF (has_email OR has_phone) AND has_owner AND has_property THEN
    NEW.readiness := 'contact_found';
  ELSIF exhausted AND has_owner THEN
    NEW.readiness := 'needs_manual_review';
  ELSIF has_owner AND has_property AND NEW.pipeline_stage IN ('enriched', 'needs_review', 'ready') THEN
    NEW.readiness := 'needs_contact_info';
  ELSIF NEW.score IS NOT NULL AND NEW.score < 30 THEN
    NEW.readiness := 'low_confidence';
  ELSE
    NEW.readiness := 'researching';
  END IF;

  RETURN NEW;
END;
$function$;