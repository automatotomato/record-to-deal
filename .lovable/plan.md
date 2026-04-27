## Goal

Today the profiler tries to find seller contact info inline, but the chain is shallow (one Firecrawl pass per layer, regex-only fallbacks). Most LLC-owned leads come back without an email, so "Find Owner & Draft" produces a draft with no recipient. We'll build a dedicated **Seller Discovery agent** that's broader, more persistent, and surfaced as a first-class action in the UI — separate from the property profiler.

## How it will work

A new edge function `seller-discovery` runs a 6-pass contact hunt for one lead. Each pass is independent and only fires if its source can plausibly help, so cost stays bounded:

```text
INPUT: lead (owner_name, owner_type, property addr, mailing addr, state, county)
  │
  ├─ Pass 1  Entity unmasking
  │   - LLC/Corp/Trust → Firecrawl search OpenCorporates + state SoS
  │   - extract: officers, managing members, registered agent, formation date,
  │     principal address, related entities (same officer name)
  │
  ├─ Pass 2  Person identity resolution
  │   - For the human name found in Pass 1 (or owner if individual):
  │     Firecrawl search "<name>" + city/state on:
  │       linkedin.com/in, zoominfo, rocketreach, crunchbase,
  │       bizapedia, signalhire, apollo public profiles
  │   - Pick the best LinkedIn URL (city/state match wins ties)
  │
  ├─ Pass 3  Company website discovery
  │   - From SoS page + Google search for "<entity>" website
  │   - Domain heuristic + Firecrawl scrape homepage to confirm match
  │   - Cache the chosen domain on the lead
  │
  ├─ Pass 4  Work email via Hunter.io
  │   - Domain search → rank by decision-maker title
  │   - Email finder (first+last+domain) when we have a name → verified email
  │   - Stores Hunter confidence score
  │
  ├─ Pass 5  Personal contact scrape
  │   - Firecrawl scrape the LinkedIn-adjacent + RocketReach/ZoomInfo result
  │     pages (markdown only) AND the contact page of the company website
  │   - Regex pulls every email + phone, scores them (role-based > generic
  │     info@, in-state phone > out-of-state)
  │
  ├─ Pass 6  AI consolidation
  │   - Feed everything collected (SoS text, LinkedIn snippet, scraped
  │     pages, Hunter results) to OpenAI as a single JSON-extraction call
  │   - Model picks the single best: name, role, email, phone, LinkedIn,
  │     company website, and emits a confidence score per field
  │
OUTPUT: writes back to leads.* + enrichment_payload.discovery_v2 + activity log
```

Key differences vs today:

- **Dedicated function** so it can be re-run on its own without re-hitting ATTOM/Smarty or burning an OpenAI draft call.
- **6 passes instead of 4**, with explicit person-resolution and company-website passes (today's chain skips both).
- **Multiple Firecrawl queries per pass** instead of one — searches RocketReach/ZoomInfo/Bizapedia/Crunchbase, not just LinkedIn.
- **Per-field confidence** in the payload so the UI can show "Email · 82% · hunter.io" vs "Phone · 40% · scraped".
- **Hunter Email Finder** (not just domain search) — much higher hit rate when we already have a name.
- **Entity graph**: when SoS shows the same officer running other LLCs, we save those as related entities (good for warm intros).

## UI changes (LeadDrawer)

- New **"Find contact info"** button at the top of the Decision-maker block (separate from "Re-profile property"). Spinner + toast while running. On success the block re-renders with new fields and a per-source badge row.
- Email/phone/LinkedIn fields each get a small confidence pill and a "source" tooltip (e.g. `hunter.io · 91%`).
- If discovery returns nothing, show an inline help row: "No contact found — try giving us the company website" with a one-field input that re-runs Pass 4–6 against that domain (skipping the SoS guesswork).
- "Send" button stays disabled until there's a recipient email — already the case, just wire the new field.

## Pipeline / dashboard changes (OutreachDashboard)

- New column **"Contact"** = green dot if `decision_maker_email`, yellow if only phone/LinkedIn, red if nothing.
- New bulk action: **"Find contacts for selected"** runs `seller-discovery` for each selected lead with a small concurrency limit (3 at a time) and a progress toast — so the user can fix a whole table column in one click instead of opening every drawer.
- KPI strip gains: **"Reachable"** = leads with a verified email.

## Database

Light additive migration:

- Add `leads.company_website text` (cached so we never re-discover it).
- Add `leads.related_entities jsonb default '[]'` (other LLCs run by same officer — surfaced in drawer).
- Add `leads.discovery_confidence_by_field jsonb default '{}'` so the UI can render per-field pills.
- New enum-less text column `leads.discovery_status` with values `none | partial | reachable | failed` to drive the dashboard dot — set by the function based on whether we got an email.
- Index `leads(discovery_status)` for the dashboard filter.

(No new tables — everything piggy-backs on `leads` + `lead_activities`.)

## Cost guardrails

- Per-lead budget: max 12 Firecrawl searches + 2 Hunter calls + 1 OpenAI call. Tracked in the function and short-circuited if exceeded.
- Cache hit: if `discovery_status != 'none'` and `force !== true`, return cached result without spending. Same pattern profiler already uses.
- Bulk action limited to 25 leads per click and confirms the estimated spend before running.

## Files

**New**
- `supabase/functions/seller-discovery/index.ts` — the 6-pass agent
- `src/components/ContactSourcesBadge.tsx` — small per-field confidence/source pill

**Modified**
- `supabase/config.toml` — register `seller-discovery` (verify_jwt = true)
- `supabase/functions/profiler-run/index.ts` — when called, if no contact yet, fire seller-discovery internally before the AI draft (so the existing "Find Owner & Draft" button keeps working but actually finds an email first)
- `src/components/LeadDrawer.tsx` — new "Find contact info" button, per-field source pills, "company website" fallback input
- `src/components/OutreachDashboard.tsx` — Contact column, bulk action, "Reachable" KPI
- New migration for the columns above

## Secrets

Already configured: `FIRECRAWL_API_KEY`, `OPENAI_API_KEY`. Hunter.io is mentioned in the plan but **only used if `HUNTER_API_KEY` is set** — function degrades gracefully without it. I'll ask once whether to wire Hunter in (you mentioned the key is already added, so likely yes).

## Out of scope

- Paid skip-trace providers (BatchData, RealEstateAPI, PeopleDataLabs) — can add later as a Pass 7 if the free chain isn't getting you to 60%+ reachability.
- Per-user OAuth for richer LinkedIn data — would need a real LinkedIn dev app.
- Phone validation/carrier lookup — separate concern.

Approve and I'll ship the migration + the agent + the UI in one pass.