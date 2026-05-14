import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function emailFromPayload(payload: any): string | null {
  const email = payload?.person?.email ?? payload?.email ?? payload?.matched_person?.email;
  return typeof email === "string" && /[^@\s]+@[^@\s]+\.[a-z]{2,}/i.test(email) ? email : null;
}

function phoneFromPayload(payload: any): string | null {
  const person = payload?.person ?? payload?.matched_person ?? payload;
  const list = person?.phone_numbers ?? payload?.phone_numbers ?? [];
  const fromList = Array.isArray(list) ? (list[0]?.sanitized_number ?? list[0]?.raw_number) : null;
  const phone = fromList ?? person?.mobile_phone ?? person?.phone_number ?? payload?.phone;
  return phone && String(phone).replace(/\D/g, "").length >= 10 ? String(phone) : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let payload: any = {};
  try { payload = await req.json(); } catch (_) {}

  const email = emailFromPayload(payload);
  const phone = phoneFromPayload(payload);
  if (!phone && !email) return json({ ok: true, skipped: "no usable phone/email" });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const person = payload?.person ?? payload?.matched_person ?? payload;
  const linkedin = person?.linkedin_url ?? null;
  const first = person?.first_name ?? "";
  const last = person?.last_name ?? "";
  const name = `${first} ${last}`.trim() || person?.name || null;

  let query = supabase.from("leads").select("id, decision_maker_email, decision_maker_phone, contact_phone, data_sources").limit(5);
  if (email) query = query.or(`decision_maker_email.eq.${email},contact_email.eq.${email}`);
  else if (linkedin) query = query.or(`decision_maker_linkedin.eq.${linkedin},contact_linkedin.eq.${linkedin}`);
  else if (name) query = query.ilike("decision_maker_name", `%${name}%`);
  else return json({ ok: true, skipped: "no match key" });

  const { data: leads, error } = await query;
  if (error) return json({ error: error.message }, 500);

  let updated = 0;
  for (const lead of leads ?? []) {
    await supabase.from("leads").update({
      decision_maker_phone: phone ?? lead.decision_maker_phone,
      contact_phone: phone ?? lead.contact_phone,
      decision_maker_email: email ?? lead.decision_maker_email,
      has_contact: true,
      has_outreach_contact: true,
      pipeline_stage: "enriched",
      data_sources: Array.from(new Set([...(lead.data_sources ?? []), "apollo.io:phone_webhook"])),
      updated_at: new Date().toISOString(),
    }).eq("id", lead.id);
    updated++;
  }

  return json({ ok: true, updated });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}