// Scaffolded but DISABLED. Polls the connected Gmail inbox for replies on
// any thread we previously sent (via outreach_emails.gmail_message_id) and
// records each reply as an inbound touchpoint, flipping the lead's status
// to "replied" the first time. Wire to a cron job or call manually to
// activate.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GATEWAY_URL = "https://connector-gateway.lovable.dev/google_mail/gmail/v1";
const ENABLED = false; // flip to true when ready

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  if (!ENABLED) {
    return new Response(
      JSON.stringify({ ok: true, disabled: true, message: "Reply polling is scaffolded but disabled." }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  const gmailKey = Deno.env.get("GOOGLE_MAIL_API_KEY");
  if (!lovableKey || !gmailKey) {
    return new Response(JSON.stringify({ error: "gmail_not_connected" }), {
      status: 412, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const admin = createClient(supabaseUrl, serviceKey);
  // Pull the last 100 sent emails with a gmail_message_id but no recorded reply yet
  const { data: sent } = await admin
    .from("outreach_emails")
    .select("id, lead_id, gmail_message_id, sent_at")
    .eq("status", "sent")
    .not("gmail_message_id", "is", null)
    .order("sent_at", { ascending: false })
    .limit(100);

  let newReplies = 0;
  for (const row of sent ?? []) {
    // Find the thread for this sent message
    const r = await fetch(
      `${GATEWAY_URL}/users/me/messages/${encodeURIComponent(row.gmail_message_id!)}?format=metadata`,
      { headers: { Authorization: `Bearer ${lovableKey}`, "X-Connection-Api-Key": gmailKey } },
    );
    if (!r.ok) { await r.text(); continue; }
    const meta = await r.json();
    const threadId = meta?.threadId;
    if (!threadId) continue;

    const t = await fetch(
      `${GATEWAY_URL}/users/me/threads/${encodeURIComponent(threadId)}?format=metadata`,
      { headers: { Authorization: `Bearer ${lovableKey}`, "X-Connection-Api-Key": gmailKey } },
    );
    if (!t.ok) { await t.text(); continue; }
    const thread = await t.json();
    const messages: any[] = thread?.messages ?? [];
    // Inbound messages = labelIds includes INBOX and not SENT
    const inbound = messages.filter((m) =>
      Array.isArray(m.labelIds) && m.labelIds.includes("INBOX") && !m.labelIds.includes("SENT"));
    for (const m of inbound) {
      // Dedup: skip if we already recorded this gmail message id
      const { data: existing } = await admin.from("lead_touchpoints")
        .select("id").eq("metadata->>gmail_message_id", m.id).maybeSingle();
      if (existing) continue;
      const headers = (m.payload?.headers ?? []) as { name: string; value: string }[];
      const subj = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? null;
      const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value ?? null;
      await admin.from("lead_touchpoints").insert({
        lead_id: row.lead_id, user_id: null,
        kind: "email_reply", direction: "inbound",
        subject: subj, body: m.snippet ?? null, outcome: "replied",
        metadata: { gmail_message_id: m.id, gmail_thread_id: threadId, from },
      });
      await admin.from("leads").update({ status: "replied" }).eq("id", row.lead_id);
      newReplies += 1;
    }
  }

  return new Response(
    JSON.stringify({ ok: true, scanned: sent?.length ?? 0, new_replies: newReplies }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
