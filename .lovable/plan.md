# Close client-deliverability gaps

Goal: ship a 1031 lead platform that consistently produces sendable, contact-rich leads with branded email outreach.

**Locked decisions from Q&A:**
- Default OpenAI model: `gpt-5.1` (override via `OPENAI_MODEL` secret)
- Web-grounded discovery: Firecrawl `/v2/search` (replaces Gemini Google Search)
- Gmail connector: needs to be connected — will prompt as part of step 3
- Quality bar: ≥ 60% of qualified leads end with a usable email or phone before we call this deliverable

## 1. Lock in OpenAI model + harden AI calls

- Set `OPENAI_MODEL` default to `gpt-5.1` in `lead-brief`, `seller-discovery`, `scan-external-sources`.
- On first invocation per cold start, log the active model so it's visible in edge logs.
- In each function, wrap the OpenAI call so 4xx/5xx return `200 { ok:false, fallback:true, error, message }` instead of throwing — `lead-brief` already does this; mirror it in the other two so the worker chain never wedges on a single bad response.
- Add a 30s `AbortController` timeout on every OpenAI call so a hung request can't block the dispatcher.

## 2. Restore web-grounded discovery via Firecrawl Search

OpenAI chat-completions has no built-in search. The Gemini grounding tool is gone. Replace with Firecrawl `/v2/search`.

- New helper `firecrawlSearch(query, { limit, scrapeOptions })` in `seller-discovery` and `scan-external-sources`.
- **`seller-discovery` Pass 5** (`geminiPublicContactHunt`): rename to `webPublicContactHunt`. Build 2–3 targeted queries per lead (e.g. `"<owner_name>" "<city>" linkedin`, `"<owner_name>" email contact`, `"<entity>" site:sec.gov OR site:opencorporates.com`). Pull top 5 results with markdown, then feed snippets to `gpt-5.1` to extract `{name, role, email, phone, linkedin, company_website, source_urls, confidence}`. Keep the existing JSON shape so consolidation doesn't change.
- **`scan-external-sources`**: rename `geminiGroundedExtract` → `webGroundedExtract`. For each (state, source) pair, run a Firecrawl search query tuned per source (Crexi/LoopNet/court records/SEC), scrape the top 8 results, and have `gpt-5.1` extract candidate transactions from the combined markdown.
- Cap Firecrawl spend per lead: max 4 search calls, max 12 scraped pages.

## 3. Wire end-to-end Gmail send

- Prompt user via the connector flow to authorize Gmail (the existing `send-outreach-email` already calls the gateway — it just needs the connection).
- Once connected, send a single test email from `LeadDrawer` to a controlled inbox; verify `outreach_emails.status='sent'` + `gmail_message_id` written.
- Schedule `poll-email-replies` via `pg_cron` every 5 minutes so replies flow into `lead_activities` automatically.
- Gate `draft-outreach` on `has_outreach_contact = true` so we never burn OpenAI tokens drafting an email we can't send.
- Add a "Send failed" badge in the LeadDrawer so a stuck draft is visible, not silent.

## 4. Pipeline observability + stuck-job recovery

- New `pipeline-sweeper` cron (every 5 minutes):
  - reset jobs `status='running' AND locked_at < now() - interval '15 min'` back to `retry`
  - move jobs with `attempts >= max_attempts` to `failed` with the last error preserved
- Admin-only widget on `/outreach`: counts per `pipeline_jobs.status` and per `kind`, plus contact-discovery hit rate (last 24h / 7d).
- Log every OpenAI call into `lead_activities` (`kind='ai_call'`) with model, tokens used, and approximate cost — so we can audit cost-per-lead and the client sees value.

## 5. QA pass + handoff

- Run 25 leads end-to-end across at least 2 high-tax states. Measure:
  - % with email or phone (target ≥ 60%)
  - % with AI brief that references real facts (sample 5, manual check)
  - average cost per lead (Firecrawl + OpenAI combined)
- Tighten the `lead-brief` system prompt if briefs feel generic at `gpt-5.1`.
- Quick README in repo root: pipeline diagram, env vars, how to add a county, how to rotate the OpenAI key.
- Final security scan + RLS review.

## Out of scope this round

- New UI features beyond the admin observability widget
- New data sources beyond what `scan-external-sources` already hits
- AI auto-classification of email replies (poll exists; classification is a future pass)
- Multi-tenant / agency accounts
