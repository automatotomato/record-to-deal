## Goal

Stop using Apollo for contact discovery (it's been the main blocker — locked emails, missing phone webhooks, low hit rate). Lean on what actually works: Firecrawl scraping + Gemini grounded Google Search via the Lovable AI Gateway. Then fix the remaining broken pieces in the pipeline.

## 1. Rip Apollo out of contact discovery

**`supabase/functions/seller-discovery/index.ts`**
- Delete Pass 4 (Apollo people/match, reveal-by-hints, org-people search) entirely.
- Remove `apolloMatch`, `apolloRevealByHints`, `apolloOrgPeople`, `applyApolloPerson`, `APOLLO_HEADERS`, `APOLLO` constant, `phoneWebhookUrl`, `BUDGET.apollo`, and `Budget.apollo`/`canApollo`.
- Renumber passes: entity unmask → person identity → website discovery → source record scrape → Gemini public hunt → personal contact scrape → AI consolidation.
- Bump Gemini hunt budget from 2 → 3 calls and Firecrawl budget from 12 → 15 to compensate.
- Update activity log line to drop "Apollo" wording.

**`supabase/functions/enrich-contact/index.ts`**
- Remove all Apollo logic (`apolloSearch`, `apolloReveal`, `applyRevealed`, key checks).
- Keep the lightweight Firecrawl LinkedIn lookup so we still seed `decision_maker_linkedin` early.
- After the Firecrawl pass, always enqueue `seller_discovery` (which is now Gemini-driven) instead of trying to short-circuit with Apollo.
- Update `data_sources` tags accordingly.

**`supabase/functions/apollo-phone-webhook/index.ts`**
- Delete the function file.

**`supabase/config.toml`**
- Remove the `[functions.apollo-phone-webhook]` block if present (nothing to add — function is gone).

**`supabase/functions/job-dispatcher/index.ts`**
- No code change needed (it never dispatched the webhook directly).

## 2. Fix lead-brief to use Lovable AI Gateway

**`supabase/functions/lead-brief/index.ts`**
- Switch from `OPENAI_API_KEY` + OpenAI endpoint to `LOVABLE_API_KEY` + `https://ai.gateway.lovable.dev/v1/chat/completions` with model `google/gemini-3-flash-preview` and the standard `Lovable-API-Key` / `X-Lovable-AIG-SDK` headers.
- Drop the `mailing_address` field from the facts blob (it's no longer surfaced).

## 3. Database cleanup — drop mailing_address

The column is no longer used in UI or pipeline. Migration to:
- `ALTER TABLE public.leads DROP COLUMN mailing_address;`
- Update `compute_lead_readiness` trigger if it touches it (it doesn't, confirmed).

## 4. Re-queue stuck leads

After deploy, re-queue leads currently stuck in `needs_review` / `discovery_status in ('failed','partial','none')` for fresh `seller_discovery` runs through the new Apollo-free path. Reset any `pipeline_jobs` left in `running` > 15 min to `retry`.

## What stays the same

- 8-stage worker chain, dispatcher, scoring, frontend dashboard, drawer, scout runs, draft-outreach, send-outreach-email — untouched.
- Apollo secret stays in the project (harmless), just no code path uses it.

## Open question

Currently `draft-outreach` may run before contact info exists. Do you want me to also gate `draft_outreach` enqueue on `has_outreach_contact = true` only (it mostly already does, but `enrich-contact` still queues it on website-only matches)? Default: yes, only enqueue when there is an email or phone — websites alone won't yield a sendable email.
