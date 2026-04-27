# Stronger leads + CRM dashboard + one-click send

Today we know the property cold (ATTOM/Smarty), but the seller side stops at a mailing address. To turn this into a working CRM for 1031 prospecting we need three things:

1. **More & better seller data** (email, phone, LinkedIn, decision-maker behind the LLC).
2. **CRM-style touchpoint tracking** so each lead has a clear status, owner, next step, and history.
3. **One-click send from the user's own mailbox** so drafts go out as the sender, not from a generic system address.

---

## 1) Stronger lead enrichment — what we add and why

We already pull *property* facts well. The gap is **seller contact + decision-maker identification**. Here's the layered enrichment chain I'll build into `profiler-run`:

| Layer | Source | What it gives us | Cost / access |
|---|---|---|---|
| Already have | ATTOM / Smarty | Owner name, mailing address, sale price, mortgage history | ✅ done |
| **NEW — Entity unmasking** | OpenCorporates API | If owner is an LLC/Corp/Trust → real principals (managers, officers, registered agent) | Free tier 500/mo, then paid; or scrape state SoS as fallback |
| **NEW — Skip-trace contact** | BatchData / RealEstateAPI / PeopleDataLabs (pick one) | Phone, email, age, relatives for the human behind the property | Per-hit pricing, cached forever in DB |
| **NEW — Pro / business email** | Hunter.io domain search (when company name → domain known) | Verified work email + confidence score | Free 25/mo, then paid |
| **NEW — LinkedIn / web presence** | Firecrawl (already wired) → targeted search + extract | LinkedIn URL, company website, news mentions, role/title | ✅ key already configured |
| **NEW — Public news / press** | Firecrawl `qdr:y` search on owner name + city | Recent business news, exits, deals — wealth & timing signals | ✅ |
| **NEW — Court / probate / divorce** | Firecrawl on county court portals (where indexed) | Probate (heir motivation), divorce (forced sale), bankruptcy | ✅, opt-in per county |
| **NEW — Lovable AI extractor** | `google/gemini-2.5-flash` over scraped pages | Pulls the highest-confidence email/phone/LinkedIn from messy HTML | ✅ already used |

I'll add all of these as **optional layers** — each one only fires if its API key is configured, and every successful pull is **cached on the lead row + logged as a `lead_activities` entry** so we never re-pay for the same person.

### Why this works for 1031 specifically
- Most high-value sellers are LLCs. Without entity unmasking, we're emailing a registered agent's PO box. OpenCorporates → real human → skip-trace → personal email **changes the response rate completely**.
- Probate and divorce filings are *the* highest-intent 1031 triggers. Adding court searches per county lets the qualifier auto-flag `trigger_event = 'probate' | 'divorce' | 'pending_sale'` and bump those leads to URGENT.

### Database additions (migration)
Add to `leads`:
- `decision_maker_name`, `decision_maker_role` text
- `decision_maker_email`, `decision_maker_phone`, `decision_maker_linkedin` text
- `entity_registry_url` text (OpenCorporates / SoS link)
- `enrichment_confidence` int (0–100, separate from contact_completeness)
- `enrichment_payload` jsonb (raw cached responses per source for audit)
- `next_action` text, `next_action_at` timestamptz (CRM follow-up)
- `assigned_user_id` uuid → profiles.id (rename from `assigned_to` if needed; keep current column)

New table `lead_touchpoints` (proper CRM activity log, separate from system `lead_activities`):
- `id`, `lead_id`, `user_id`, `kind` (email_sent | call | meeting | note | linkedin_msg | sms), `direction` (outbound | inbound), `subject`, `body`, `outcome` (no_answer | replied | left_voicemail | meeting_booked | not_interested | bad_contact), `occurred_at`, `created_at`
- RLS: authenticated read all, insert own, update own.

### Required new secrets (all optional — system degrades gracefully)
I'll request these one at a time only if you say yes to each:
- `OPENCORPORATES_API_KEY` (entity unmasking) — strongly recommended
- `BATCHDATA_API_KEY` **or** `REALESTATEAPI_KEY` (skip trace) — pick one, recommended
- `HUNTER_API_KEY` (work-email finder) — nice-to-have

---

## 2) CRM-style dashboard — what changes in the UI

The dashboard becomes a real pipeline view, not just a list:

### New "Pipeline" view (Kanban) — added as a third tab
Columns = lead `status`: New → Reviewing → Contacted → Replied → Meeting → Won / Dead. Drag a card to change status (already supported, just visualized). Each card shows tier pill, days-since-sale window pill, owner, $ tax exposure, and a count badge of touchpoints.

### Lead drawer becomes a CRM record
Adds three sections to `LeadDrawer`:
- **Decision-maker block** — name, title, email, phone, LinkedIn, with a "Re-enrich" button that re-runs the full chain (OpenCorporates → skip-trace → Hunter → Firecrawl).
- **Next action** — single-line "what's next + when" (e.g. "Follow-up call · Tue 2pm"), editable inline. Shows on the table row too.
- **Touchpoints timeline** — every email sent, call logged, note added, with outcome chips. "Log call / Log note / Log LinkedIn message" quick buttons.

### Table row additions
- New column **"Touch"** = last touchpoint kind + relative time (e.g. `email · 3d`).
- New column **"Next"** = next_action_at relative (e.g. `call in 2d`, red if overdue).
- Assignee avatar pill (so multiple agents can split the desk).

### KPI strip stays 4 metrics but more useful
- Active leads · Urgent · Awaiting reply (sent ≥3d ago, no inbound) · Pipeline tax exposure.

---

## 3) One-click "Send from your mailbox"

Today the AI drafts an email but there's no send. We'll wire a **Gmail connector** (and/or Outlook) so each user can connect their own mailbox once, then every draft has a **Send** button that goes out *from their address*, threaded properly, and gets logged as a touchpoint.

### How it works
1. **One-time setup** — first time a user clicks Send, we run `standard_connectors--connect` for **Google Mail** (and offer Microsoft Outlook as an alternative). They authorize their own inbox; tokens are managed by Lovable's connector gateway (auto-refresh, no token plumbing in our code).
2. **Send button** — appears on every draft in the LeadDrawer. Clicking it calls a new `send-outreach-email` edge function which:
   - Reads the draft from `outreach_emails`
   - Calls Gmail API `users/me/messages/send` (or Outlook `me/sendMail`) through the connector gateway
   - Updates the row: `status = 'sent'`, `sent_at = now()`, `sent_by = auth.uid()`, `gmail_message_id = ...`
   - Inserts a `lead_touchpoints` row (kind=`email_sent`, direction=`outbound`)
   - Bumps lead `status` to `contacted` if currently `new` or `reviewing`, sets `last_contacted_at`
3. **Reply detection (phase 2, optional)** — a scheduled function polls the user's `INBOX` for messages whose threadId matches a sent message → auto-creates an `inbound` touchpoint and flips status to `replied`. I'll scaffold this but leave it disabled until you want it on.

### Important caveat (must be transparent)
The Gmail connector connects **the builder's Gmail account that authorized it**. If you have multiple agents and each needs to send from their own address, each agent has to authorize their own connection — we'll detect that and prompt them to connect on first send. (This is a connector-level constraint, not something we can work around without per-user OAuth, which is a much larger change.)

### UI details
- LeadDrawer → "Outreach draft" section gets two buttons: **Send from my Gmail** (primary) and **Copy** (fallback).
- If contact_email is missing, Send is disabled with a tooltip "Add a recipient email first" + an inline "Find email" button that triggers the enrichment chain.
- After send, the draft section flips to a read-only "Sent · 12s ago by you · view in Gmail" row with a deep link to the Gmail thread.

---

## Files I'll change

**Database (migrations):**
- Add new columns on `leads` (decision_maker_*, next_action, enrichment_*).
- New table `lead_touchpoints` with RLS.

**Edge functions:**
- `profiler-run/index.ts` — append OpenCorporates → skip-trace → Hunter → Firecrawl person-search chain after the existing ATTOM/Smarty step. Cache everything on the lead row.
- **NEW** `send-outreach-email/index.ts` — sends a draft via Gmail/Outlook connector gateway, updates the email row, logs a touchpoint.
- **NEW** `enrich-decision-maker/index.ts` — small focused function the "Re-enrich" button calls; same chain as above but only the contact layers, not the AI re-draft.

**Frontend:**
- `OutreachDashboard.tsx` — add Pipeline (Kanban) tab, "Touch" + "Next" + "Assignee" columns, update KPIs.
- `LeadDrawer.tsx` — add Decision-maker block, Next action, Touchpoints timeline, Send button on draft, log-call / log-note quick actions.
- New component `TouchpointTimeline.tsx`.
- New component `DecisionMakerCard.tsx` with the "Re-enrich" CTA.

**Connector setup (handled at first Send click):**
- Connect Google Mail via the standard connector flow.

---

## What I'll ask you before coding

So we don't over-spend on enrichment APIs you don't want, on approval I'll come back with a single short multi-choice question covering:
1. Which skip-trace provider to wire (BatchData, RealEstateAPI, or skip for now).
2. Whether to enable OpenCorporates entity unmasking (free tier sufficient for ~500 leads/mo).
3. Whether to enable Hunter.io for work-email finding.
4. Gmail only, Outlook only, or both for one-click send.

Then I'll request only the secrets you say yes to, and ship the rest.

---

## Out of scope (intentionally)

- Per-user OAuth for Gmail across many agents (connector model is one mailbox per connection — we'll prompt each user to connect their own, but won't build a custom OAuth app).
- Two-way email sync / full inbox mirroring — just send + optional reply detection on threads we sent.
- SMS sending (we can log SMS touchpoints, but not send them — would need Twilio).
- Calendar/meeting booking — separate feature, can add later.

Approve and I'll start with the migrations + the question above, then ship enrichment, CRM UI, and one-click send.
