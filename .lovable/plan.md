# 1031 Exchange Lead Agent — MVP Build Plan

A multi-agent system that scrapes public county records for property sales in high-tax states, qualifies the owners as 1031 exchange candidates targeting Las Vegas, profiles them, drafts personalized outreach emails, and lets you send them — all from a single dashboard.

## Scope

- **Pipeline**: All three layers — Scout → Qualifier → Profiler
- **Data source**: Public county scrapers, starting with **2 counties** (Los Angeles County, CA + Cook County, IL — highest-volume targets in two top-tax states)
- **Geography target**: High-tax origin states only — CA, NY, IL, NJ, OR, MA (counties added incrementally)
- **Outreach**: View leads + AI-drafted personalized email + send directly via Gmail (your connected account)

## What we're building

### 1. Outreach Dashboard (`/outreach`)
- **Lead pipeline table**: ranked by score, color-coded by tier (URGENT / HOT / WARM / COLD)
- **Filters**: state, county, score range, status (new / contacted / replied / dead), urgency, property type, min capital gains
- **Detail drawer per lead**: property facts, owner profile, wealth signals, score breakdown, AI-drafted email, send button, activity log
- **KPI strip**: total leads, urgent count (closed in last 30 days), avg score, sent today, reply rate
- **Manual "Run Scout now"** button + scheduled daily runs
- **CSV export** of filtered view

### 2. Scout Agent (Layer 1)
Edge function `scout-run` that scrapes recent deed filings + MLS-style listing data from configured counties.
- v1 sources: LA County Registrar-Recorder public deed search + Cook County Recorder of Deeds public search (both have free public web portals — we scrape with Firecrawl)
- Filters to investment property indicators: non-owner-occupied (mailing address ≠ property address), commercial/multifamily zoning, LLC/Trust ownership, sale price > $500k
- Writes raw `lead` rows with confidence score
- Runs daily on a cron schedule + on-demand from dashboard

### 3. Qualifier Agent (Layer 2)
Edge function `qualifier-run` triggered after each Scout run.
- Scores each lead 0–100 across: property value, capital gains estimate (sale price − assessed basis − depreciation), ownership length, owner type, location in target tax state, contact completeness
- **Urgency override**: any lead closed in last 30 days → flagged URGENT regardless of score
- Enriches with: estimated wealth signals (other properties owned, LLC affiliations via OpenCorporates free API, ProPublica nonprofit board seats)
- Attempts contact enrichment via free sources (county tax mailing address, public WHOIS-style lookups). Phone/email left blank if not found — flagged as "needs manual lookup"
- Tiers: URGENT (closed <30d) / HOT (80+) / WARM (65–79) / COLD (50–64) / DISQUALIFIED (<50)

### 4. Profiler Agent (Layer 3)
Edge function `profiler-run` for each qualified lead.
- Uses Lovable AI (Gemini) to infer: personality type (Legacy Builder / Yield Hunter / Active Investor / C-Suite / Ultra-HNW), primary motivation, recommended Las Vegas property category, best outreach channel
- Generates a personalized first email matching the spec's drafting prompt
- Result stored on the lead; editable in the detail drawer before sending

### 5. Outreach via Gmail
- Connect your Gmail account (one-click connector flow)
- "Send" button in detail drawer sends the AI-drafted email from your inbox
- Sent emails logged with timestamp; lead status auto-moves to `contacted`
- Reply detection (later phase) — for now you mark replied/dead manually

### 6. Auth
- Single-user / small team. Email + password auth via Lovable Cloud
- Roles table (admin / agent) — admins can configure counties and trigger scout runs

## Data model

```text
counties           — configured scrape targets (state, county, source_url, enabled, last_run_at)
leads              — unified lead record (Scout + Qualifier + Profiler fields per spec section 5)
lead_activities    — append-only log: scraped, scored, profiled, emailed, replied, status_change
outreach_emails    — drafted + sent emails (subject, body, sent_at, gmail_message_id)
scout_runs         — run history with stats (counties, leads found, errors)
profiles + user_roles — auth
```

## User flow

```text
Login → /outreach dashboard (URGENT bucket on top)
  → click lead row → side drawer opens
    → review property + owner + score breakdown
    → review/edit AI-drafted email
    → click "Send via Gmail" → email goes out → status flips to Contacted
  → filter by state/score/urgency to work the pipeline
  → "Run Scout" (admin) to pull fresh leads on demand
```

## Technical details

- **Stack**: React + Vite + Tailwind + shadcn/ui (existing); Lovable Cloud (Supabase) for DB/auth/edge functions
- **Scraping**: Firecrawl connector for the two county sites (handles JS rendering + anti-bot). Each county gets its own parser module so we can add more counties cleanly later.
- **AI**: Lovable AI Gateway (Gemini 2.5 Flash) for Qualifier enrichment reasoning + Profiler personality inference + email drafting. No separate API key needed.
- **Email send**: Gmail connector via gateway (`gmail.send` scope). Sends from your authenticated inbox.
- **Free enrichment APIs**: OpenCorporates (LLC lookup), ProPublica Nonprofit Explorer, USPS address validation
- **Scheduling**: pg_cron job runs `scout-run` daily at 6am PT
- **Edge functions**: `scout-run`, `qualifier-run`, `profiler-run`, `send-outreach-email`, `lead-export-csv`
- **Secrets needed**: Firecrawl + Gmail connectors (one-click), Lovable AI key (auto)

## Honest caveats

- **County scrapers are fragile**: when LA County or Cook County change their site HTML, the parser breaks. We'll add error logging + dashboard alerts so you know when a source goes down. Plan to budget time monthly to fix parsers, or upgrade to ATTOM Data later for stability across all 50 states.
- **Contact enrichment is limited on free sources**: many leads will have no phone/email and need manual lookup (LinkedIn, etc.). The dashboard surfaces this gap clearly.
- **Las Vegas property recommendations** are AI-inferred categories (e.g., "Summerlin luxury SFR", "Ascaya custom lot") — not live MLS listings. Adding a live LV inventory feed is a future phase.
- **Scaling counties**: each new county = a new parser module. We start with 2 and add more on request.

## Build order

1. DB schema + auth + roles + empty `/outreach` dashboard shell
2. Scout for LA County (one source end-to-end) → leads appear in dashboard
3. Qualifier scoring + urgency override + tier filtering
4. Profiler + AI email drafting + detail drawer
5. Gmail connector + send flow + activity log
6. Add Cook County scraper, daily cron, CSV export, KPI polish