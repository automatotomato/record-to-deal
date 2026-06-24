## Goal

Stop pulling "seller" info from Zillow / LoopNet / MLS / broker pages. Treat the **county recorder's recorded deed** as the source of truth, take the **grantor** as the real seller, and unmask LLC grantors to a human via free public sources (OpenCorporates + state Secretary of State filings).

## Why the current pipeline misses contacts

- `scan-sources` queries the open web with broad keywords. Top results are broker/listing pages (LoopNet, Crexi, brokerages), so the "owner" we extract is often the listing agent, not the grantor on the deed.
- `seller-discovery` has an OpenCorporates / SoS pass, but it runs *after* a Firecrawl / LinkedIn pass that locks in whatever name `scan-sources` saved first. If that name is a broker, every downstream pass enriches the wrong person.
- Counties have a generic `source_url` field, but it isn't consistently a recorder/clerk deed index URL and `scan-sources` doesn't prioritize that domain.

## Plan

### 1. Make the county recorder the primary source

- Add a `recorder_index_url` column to `counties` (separate from `source_url`).
- Rewrite `scan-sources` query strategy:
  - Pass 1 — **recorder-first**: query restricted to `site:<recorder_index_url host>` plus a generic `"<county> county recorder" OR "official records" OR "recorded deed" grantor grantee` query.
  - Pass 2 — **government aggregators**: `site:*.gov` and known recorder aggregator domains for that state.
  - Hard-exclude broker/MLS hosts (LoopNet, Crexi, Zillow, Realtor, Redfin, Trulia, Auction.com, Movoto, Homes.com, brokerage domains) from every query, in every state — not just NV.
- Update the AI extraction prompt to require `grantor_name` (seller) and `grantee_name` (buyer); save `grantor_name` into `leads.owner_name`.
- Reject any record whose source URL is on the broker/MLS deny-list, even if the model fills fields.

### 2. Disable counties without a free recorder source

- Counties whose recorder requires login or charges per record (several CA counties, etc.) get `enabled = false` and a `notes` value explaining "awaiting paid bulk source". They stay off the cron until we wire a paid provider.
- Counties with a free public deed search (Miami-Dade, Maricopa, Travis, etc.) get a `recorder_index_url` seeded and stay enabled.
- Surface the locked-out counties in the Sources page so it's obvious which ones are parked.

### 3. Unmask the LLC first, before any LinkedIn / web pass

In `seller-discovery`:

- Reorder passes so **Pass 1 (Entity Unmask via OpenCorporates + state SoS)** must run and complete for any `owner_type` in `LLC | Trust | Corporation | Estate` before later passes.
- OpenCorporates: hit the public JSON API (`https://api.opencorporates.com/v0.4/companies/search`) filtered by jurisdiction = the lead's state. No key needed at low volume.
- State SoS: Firecrawl-scrape the state's business entity search; tighten query to `"<entity name>" site:<state SoS host>` and parse registered agent + officers/members.
- Persist findings to the lead: `entity_registry_url`, registered agent, officers/members list in a new `leads.entity_principals jsonb` column.
- Promote the best human principal (manager → member → officer → registered agent) to `decision_maker_name` with role.
- Only then does Pass 2 (LinkedIn / personal contact hunt) run, against the unmasked human, not the LLC string.

### 4. Guardrails so brokers can't sneak back in

- In `enrich-contact` and `seller-discovery`, add a broker/agent deny-list check on any candidate name/email/phone (domains like `@compass.com`, `@kw.com`, `@cbre.com`, etc., and titles like "Realtor", "Listing Agent", "Broker Associate") — reject and try the next candidate.
- In the lead drawer, surface the unmask trail: "Grantor on deed: ACME HOLDINGS LLC → SoS principal: Jane Doe (Manager) → contact found via …".

### 5. Backfill

- Re-queue `seller_discovery` for existing leads whose `owner_type` is LLC/Trust/Corp and whose `decision_maker_name` is empty or matches the broker deny-list, so we recover leads already in the DB.

## Technical details

Files touched:

- `supabase/migrations/<new>.sql` — add `counties.recorder_index_url text`, add `leads.entity_principals jsonb`, set `enabled = false` + note on counties with no free recorder source, seed `recorder_index_url` on counties that do.
- `supabase/functions/scan-sources/index.ts` — recorder-first query builder, universal broker deny-list, grantor/grantee extraction, `owner_name = grantor`.
- `supabase/functions/seller-discovery/index.ts` — mandatory OpenCorporates + SoS Pass 1 for entity owners, OpenCorporates JSON API call, persist principals, deny-list filter on later passes.
- `supabase/functions/enrich-contact/index.ts` — apply the broker deny-list before seeding LinkedIn.
- `src/components/LeadDrawer.tsx` — show the unmask trail.
- `src/pages/Admin.tsx` — display each county's `recorder_index_url` and parked-with-reason status; let admins paste a URL to re-enable.

Out of scope (will ask before doing): paid data providers (DataTree, PropertyRadar, TitlePro), building per-county recorder scrapers beyond Travis, and any change to outreach / Touchpoints UI.
