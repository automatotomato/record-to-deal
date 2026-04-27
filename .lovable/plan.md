## Goal

Make seller/owner contact info appear automatically on every property the Scout discovers — not just Tier A/B — and pull the official mailing address from the county assessor record so direct-mail outreach is reliable.

## Changes

### 1. Profiler edge function — add county assessor lookup
File: `supabase/functions/profiler-run/index.ts`

Before the existing Firecrawl web searches, run a targeted scrape of the county assessor parcel page when we have a `parcel_number` or `property_address`:

- **LA County** (`assessor.lacounty.gov`) — query by AIN (parcel number) or address; extract the `Mail Address` block.
- **Cook County** (`cookcountyassessor.com`) — query by PIN or address; extract the `Mailing Address` and `Taxpayer Name` fields.
- Generic fallback for other counties: Firecrawl search `"<parcel>" site:<county-assessor-domain>` and let the AI extract the mailing block.

Feed the assessor result into the AI prompt as a separate, **trusted** source block ("OFFICIAL COUNTY RECORD — prefer this for mailing_address and taxpayer name"). The AI already returns `mailing_address`; we just give it a stronger signal and stop relying on guesses.

Also bump `contact_completeness` scoring to add +10 when we have a verified `mailing_address` from the assessor (so direct-mail-only leads still register as partially profiled).

### 2. Qualifier — auto-profile EVERY lead, not just Tier A/B
File: `supabase/functions/qualifier-run/index.ts`

Currently lines ~228–240 fan out Profiler only for Tier A+B (capped at 25). Change to:
- Fan out Profiler for **every** scored lead (all tiers).
- Process in batches of 3 in parallel to respect Firecrawl rate limits.
- Cap per-run at 50 (configurable via request body) so a huge Scout run doesn't blow the function timeout — overflow gets picked up on the next run since they remain "unprofiled".
- Keep `auto_profile` flag default = true.

### 3. Scout → Qualifier chain stays the same
`scout-run` already calls `qualifier-run` on completion, so flipping the qualifier to auto-profile-all means **every newly discovered lead gets seller info pulled automatically**. No change needed in scout.

### 4. Outreach dashboard — surface seller info on the row
File: `src/components/OutreachDashboard.tsx`

Add a compact "Seller" column (or merge into existing owner column) showing:
- Owner name + a small icon row: ✉ if `contact_email`, ☎ if `contact_phone`, in if `contact_linkedin`, 🏠 if `mailing_address`.
- Greyed-out icons when missing; colored when present.
- Hover tooltip shows the actual value.

This makes it obvious at a glance which leads have full contact data vs. need a manual re-profile.

### 5. Lead drawer — dedicated "Seller / Owner" section
File: `src/components/LeadDrawer.tsx`

Group the existing scattered contact fields into one clearly-labeled **Seller Information** card at the top of the drawer with:
- Owner name + type (Individual / LLC / Trust)
- Mailing address (with "from county records" badge when sourced from assessor)
- Email · Phone · LinkedIn (clickable)
- Contact completeness bar
- "Re-profile" button to re-run if data is stale

## Technical notes

- LA assessor portal: `https://portal.assessor.lacounty.gov/parceldetail/<AIN>` — Firecrawl scrape with `formats: ['markdown']`, `onlyMainContent: true`.
- Cook assessor: `https://www.cookcountyassessor.com/pin/<PIN>` — same pattern.
- Both pages render server-side enough that Firecrawl markdown captures the mailing block reliably.
- Add a 3-second `waitFor` to handle any JS rendering.
- If assessor scrape fails (404, timeout), silently fall through to web-search-only path — never block the Profiler run.
- Throttling: Profiler calls Firecrawl ~5 times per lead; with 50 leads × parallelism 3, expect ~80s of wall time, which fits inside the 150s edge-function limit.

## Out of scope (ask after this lands)

- Secretary of State LLC principal lookup (you didn't pick this option).
- Skip-tracing services (BatchSkipTracing, Spokeo) — those are paid APIs we can add later if web-only profiling has too low a hit rate.
