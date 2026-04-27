// Sends a drafted outreach email through the user's own Gmail inbox via the
// Lovable connector gateway. Updates the outreach_emails row, creates a
// CRM touchpoint, and bumps the lead's status to "contacted" if it was new.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GATEWAY_URL = "https://connector-gateway.lovable.dev/google_mail/gmail/v1";

function rfc2822({
  to, subject, body, fromName,
}: { to: string; subject: string; body: string; fromName?: string | null }) {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
  ];
  if (fromName) lines.unshift(`From: ${fromName}`);
  return lines.concat(["", body]).join("\r\n");
}

function base64url(input: string): string {
  // UTF-8 safe base64url
  const bytes = new TextEncoder().encode(input);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  const gmailKey = Deno.env.get("GOOGLE_MAIL_API_KEY");

  if (!lovableKey || !gmailKey) {
    return new Response(
      JSON.stringify({
        error: "gmail_not_connected",
        message: "Connect your Gmail account to send from your own mailbox.",
      }),
      { status: 412, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Auth: who is sending?
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase = createClient(supabaseUrl, serviceKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await supabase.auth.getUser(authHeader.replace(/^Bearer\s+/i, ""));
  if (!user) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: { email_id?: string; to_email?: string } = {};
  try { body = await req.json(); } catch (_) {}
  const emailId = body.email_id;
  if (!emailId) {
    return new Response(JSON.stringify({ error: "email_id required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: email, error: eErr } = await admin
    .from("outreach_emails").select("*").eq("id", emailId).single();
  if (eErr || !email) {
    return new Response(JSON.stringify({ error: eErr?.message ?? "not found" }), {
      status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const recipient = body.to_email || email.to_email;
  if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return new Response(
      JSON.stringify({ error: "missing_recipient", message: "Add a recipient email first." }),
      { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Profile (for From display name)
  const { data: profile } = await admin
    .from("profiles").select("display_name, email").eq("id", user.id).maybeSingle();
  const fromName = profile?.display_name && profile?.email
    ? `${profile.display_name} <${profile.email}>`
    : null;

  const raw = base64url(rfc2822({
    to: recipient, subject: email.subject, body: email.body, fromName,
  }));

  const sendResp = await fetch(`${GATEWAY_URL}/users/me/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lovableKey}`,
      "X-Connection-Api-Key": gmailKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });

  if (!sendResp.ok) {
    const text = await sendResp.text();
    console.warn("Gmail send failed", sendResp.status, text);
    await admin.from("outreach_emails").update({
      status: "failed", error: `Gmail ${sendResp.status}: ${text.slice(0, 240)}`,
    }).eq("id", emailId);
    return new Response(
      JSON.stringify({ error: "gmail_send_failed", status: sendResp.status, detail: text.slice(0, 400) }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const sent = await sendResp.json();
  const messageId = sent?.id ?? null;
  const threadId = sent?.threadId ?? null;

  // Update email row
  await admin.from("outreach_emails").update({
    status: "sent",
    sent_at: new Date().toISOString(),
    sent_by: user.id,
    to_email: recipient,
    gmail_message_id: messageId,
    error: null,
  }).eq("id", emailId);

  // CRM touchpoint
  await admin.from("lead_touchpoints").insert({
    lead_id: email.lead_id,
    user_id: user.id,
    kind: "email_sent",
    direction: "outbound",
    subject: email.subject,
    body: email.body,
    outcome: "sent",
    metadata: { gmail_message_id: messageId, gmail_thread_id: threadId, to: recipient },
  });

  // Bump lead status to contacted if still in early stages
  const { data: lead } = await admin.from("leads").select("status").eq("id", email.lead_id).single();
  if (lead?.status === "new" || lead?.status === "reviewing") {
    await admin.from("leads").update({
      status: "contacted",
      last_contacted_at: new Date().toISOString(),
    }).eq("id", email.lead_id);
  } else {
    await admin.from("leads").update({
      last_contacted_at: new Date().toISOString(),
    }).eq("id", email.lead_id);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      gmail_message_id: messageId,
      gmail_thread_id: threadId,
      thread_url: threadId ? `https://mail.google.com/mail/u/0/#inbox/${threadId}` : null,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
