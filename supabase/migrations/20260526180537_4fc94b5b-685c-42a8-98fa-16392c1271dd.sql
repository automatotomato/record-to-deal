
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.touch_updated_at() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_lead_last_touchpoint() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.compute_lead_readiness() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_jobs(text, integer, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_staff(uuid) FROM anon;
