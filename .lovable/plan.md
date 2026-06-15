## Goal
Replace today's broker/listing-flavored scan with a recorded-deed-first pipeline, then unmask LLC grantees to a real human before contact enrichment runs. Accuracy first — no newspaper-column fallbacks, no MLS sources.

## Priority states (in order)
WA, TX, OR, CA, NY, NJ, MA, MN, FL, CO. Counties for any other state are paused (their `counties` row stays but `scan-sources` skips them) until we hand-tune their recorder source.

---

## Phase 1 — Recorder source registry

Create `supabase/functions/_shared/recorder-sources.ts` (importable by `scan-sources` and `seller-discovery`). One entry per priority state, with the official recorder/clerk portal and a search URL template:

| State | Primary source(s) |
|---|---|
| WA | County auditor recording search (e.g. King County Recorder's eRecording / Recorded Documents Search) |
| TX | County Clerk official public records (Harris, Dallas, Travis, Bexar, Tarrant) + Texas SOSDirect for entities |
| OR | County Clerk recording portals (Multnomah, Washington, Clackamas) |
| CA | County Recorder portals (LA County Registrar-Recorder, San Diego ARCC, San Francisco Assessor-Recorder, Santa Clara Clerk-Recorder, Orange County Clerk-Recorder) |
| NY | ACRIS (NYC five boroughs) + county clerk portals upstate |
| NJ | NJ County Clerk Open Public Records Search (per county) |
| MA | Massachusetts Registry of Deeds (masslandrecords.com — statewide) |
| MN | County Recorder portals (Hennepin, Ramsey, Dakota) |
| FL | County Clerk Official Records (Miami-Dade Clerk, Broward, Orange, Hillsborough, Palm Beach) |
| CO | County Clerk & Recorder portals (Denver, Arapahoe, Jefferson, Boulder) |

For each entry: `{ state, counties: { [countyName]: { recorderUrl, searchUrl, documentTypeFilter, requiresJs } } }`. `recorderUrl` is the human-facing portal; `searchUrl` is the deep-link template we feed to Firecrawl `scrape` with date-range params filled in. `requiresJs:true` triggers Firecrawl `waitFor` so single-page-app portals (ACRIS, masslandrecords) render before extraction.

## Phase 2 — Rewrite `scan-sources/index.ts` to deed-only

1. Skip the run if the county's state is not in the priority list (log a clear "paused — awaiting recorder template" event in `scout_runs`).
2. For each priority county, build the deed-search URL from the registry, filling a rolling date window (last 30 days, then 60, then 90 if zero results).
3. Call Firecrawl `scrape` (not `search`) on the populated URL with `waitFor` where required and `formats: ["markdown", "html"]`. This gives us the actual recorder result list, not a Google snippet.
4. Feed the scraped recorder page to the AI extractor with a new schema:
   - `grantor_name`, `grantee_name`
   - `document_type` (Warranty Deed, Grant Deed, Quitclaim, Trustee's Deed, Special Warranty Deed)
   - `recording_number`, `recorded_date`, `consideration_amount`
   - `legal_description` or `parcel_number`
   - `property_address` (only if the recorder page exposes it — many do not; leave null otherwise and let `verify-property` resolve it from APN via Smarty)
   - `source_record_url` must be on the recorder domain or the extraction is rejected
5. System prompt: "Only extract rows from official county recorder / clerk / registry-of-deeds pages. If the page is a brokerage, MLS, Zillow, LoopNet, Crexi, CoStar, BizBuySell, Auction.com, or a newspaper transfers column, return an empty array."
6. Reject candidates where `document_type` is missing or where `grantor` and `grantee` are identical (refinancing / name correction deeds).
7. Map to `leads`:
   - `owner_name` ← `grantee_name`
   - `prior_owner_name` ← `grantor_name` (new column)
   - `deed_date` / `sale_date` ← `recorded_date`
   - `sale_price` ← `consideration_amount`
   - `trigger_event` always `deed_recorded`
   - `document_type`, `recording_number`, `deed_source_url` persisted for audit
8. Delete the brokerage queries (`loopnet`, `crexi`) and the generic "investment property sold" prompt — they are the root cause of the bad data and stay out.

## Phase 3 — Schema additions

Single migration:
- `prior_owner_name text`
- `document_type text`
- `recording_number text`
- `deed_source_url text`
- `unmask_status text` enum-style: `pending | unmasked | sos_only | failed`
- `unmask_source text` (e.g. `opencorporates`, `sos:TX`)
- Index on `(state, county, recorded_date desc)` for dedupe

(GRANTs on `leads` already exist; RLS unchanged.)

## Phase 4 — LLC unmask hardening in `seller-discovery`

Rewrite Pass 1 (lines 434–472 today) as a real two-step flow instead of regex-on-search-snippet:

1. **Trigger**: run whenever `owner_name` matches `/LLC|L\.L\.C|INC|CORP|LP|LLP|TRUST|HOLDINGS/i`. Also re-run if `prior_owner_name` was an individual (strong signal the grantee LLC was just formed for this purchase).
2. **OpenCorporates step**:
   - Firecrawl `search` `"${ownerName}" site:opencorporates.com` → top hit → store `entity_registry_url`.
   - Firecrawl `scrape` that URL with `onlyMainContent:true` → parse the *Officers*, *Agent*, *Filings* sections specifically (not the raw page). Pull every `Name — Role — StartDate` triple. Prefer Manager / Managing Member / President / Sole Member / Member over Registered Agent (CT Corp, Cogency, NRAI, etc. are agents-for-service, not the human owner — explicitly demote these).
3. **State SoS step** (hardcoded per priority state, used either as primary or as confirmation):
   - WA: `ccfs.sos.wa.gov/#/BusinessSearch`
   - TX: `comptroller.texas.gov/taxes/franchise/account-status/` (taxable-entity search) + `direct.sos.state.tx.us` (paid — skip; use comptroller)
   - OR: `sos.oregon.gov/business/Pages/find.aspx`
   - CA: `bizfileonline.sos.ca.gov/search/business`
   - NY: `apps.dos.ny.gov/publicInquiry/` (free)
   - NJ: `www.njportal.com/DOR/BusinessNameSearch`
   - MA: `corp.sec.state.ma.us/CorpWeb/CorpSearch/CorpSearch.aspx`
   - MN: `mblsportal.sos.state.mn.us/Business/Search`
   - FL: `search.sunbiz.org/Inquiry/CorporationSearch/ByName`
   - CO: `www.coloradosos.gov/biz/BusinessEntityCriteriaExt.do`

   Build the deep-link with the entity name pre-filled, scrape it (Firecrawl `scrape` + `waitFor`), then scrape the entity detail page for officer / registered agent / manager info.
4. **Related-entity expansion**: if no human surfaces, scrape OpenCorporates' "Similar companies" and the SoS's "filings by this agent" view to find sibling LLCs that share an officer — common pattern for sponsors who use a new LLC per asset. Merge into `related_entities`.
5. **Scoring & persistence**:
   - Names from SoS officer fields → score 70, `source: "sos:<state>"`.
   - Names from OpenCorporates officer block → score 65, `source: "opencorporates"`.
   - Registered-agent-only matches → never written to `decision_maker_name`; saved to `notes` so the operator knows what we found.
   - On success set `unmask_status='unmasked'`, `unmask_source=<src>`, `decision_maker_name`, `decision_maker_role`, `entity_registry_url`.
   - On failure (no officer in any source) set `unmask_status='sos_only'` if we at least have the registry URL, else `failed`. Pass 2+ (LinkedIn, Gemini grounded) only runs when we have a human name.

## Phase 5 — UI verification surface in `LeadDrawer`

Add a "Deed Provenance" panel above the existing Touchpoints section:
- Document type, recording #, recorded date
- Grantor → Grantee
- Link out to `deed_source_url` (recorder portal)
- "Unmasked via: OpenCorporates / Nevada SOS" badge with link to `entity_registry_url`, plus list of related entities

Read-only; no data mutation from the UI. Helps the operator trust the contact and spot bad unmasks fast.

## Phase 6 — Backfill & operator action

- Add a "Re-scout with deed source" button on each lead in `Admin → Sources` that re-queues `scan_sources` for that county with the new pipeline and a 90-day window.
- One-time SQL: mark existing leads with `source_record_url` matching `loopnet|crexi|costar|zillow|realtor|bizbuysell` as `discovery_status='stale_source'` so they're hidden from the outreach queue until re-verified.

---

## Technical notes
- Files changed: `supabase/functions/scan-sources/index.ts`, `supabase/functions/seller-discovery/index.ts`, new `supabase/functions/_shared/recorder-sources.ts`, one migration, `src/components/LeadDrawer.tsx`, `src/pages/Admin.tsx` (re-scout button only).
- No new secrets. OpenCorporates and every SoS portal listed above are free public records and scrape cleanly through the existing Firecrawl key.
- Firecrawl call budget per lead unchanged (`fc=15`, `ai=3`); we're substituting query targets, not adding passes.
- Job-kind chain unchanged: `scan_sources` → `verify_property` → `qualify_lead` → `seller_discovery` → `enrich_contact`.
- Non-priority states keep their `counties` rows so we can flip them on later by adding a registry entry — no schema migration needed at that point.

## Out of scope
- Newspaper "property transfers" columns (you ruled out — accuracy first).
- Paid recorder APIs (DataTree, TitlePro247, ATTOM) — not needed for the priority states; revisit only if Firecrawl scraping is blocked by a specific portal.
- Per-user OAuth into any recorder portal — all listed sources are anonymous public records.
