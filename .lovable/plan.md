# Tier 1 — Sharpen targeting

Three changes that make today's pipeline more valuable without new vendors.

## a. Surface the 1031 clock

Every qualified lead gets the two deadlines that drive the cold-email hook.

- Extend `qualify-lead` to compute and persist:
  - `days_until_45_deadline` = 45 − days_since_sale
  - `days_until_180_deadline` = 180 − days_since_sale
- Add both columns to `leads` (integer, nullable).
- Show them in `OutreachDashboard` as a small red/amber chip ("31 days to identify").
- Pass both into `draft-outreach-step` prompts so the first line of every email leads with the clock.

## b. Refine state-arbitrage math (city surcharges)

Today we treat CA as a single rate, but NYC adds ~3.876% and Portland adds ~4% — those are the biggest pitches we have.

- Add a `city_surcharges` jsonb column to `state_tax_rates` (e.g. `{ "NYC": 0.03876, "PORTLAND": 0.04, "SF": 0.0 }`).
- In `qualify-lead`, detect city from `property_address` and add the matching surcharge into `state_tax_rate` + recompute `state_capital_gains_estimate` and `total_tax_exposure`.
- Seed surcharges for: NYC (all 5 boroughs), Yonkers, Portland OR, Newark NJ, Jersey City NJ. (SF/LA already covered by CA state rate.)
- Re-score existing qualified leads once after deploy.

## c. Tighten `scan_external` rotation

Replace the generic `residential` bucket with two arbitrage-focused buckets aimed at HIGH_ARBITRAGE states.

- Update `run_scout_cron()` source list from `{commercial, residential, court, sec}` → `{commercial, pending_sale, recent_close, court, sec}` (residential dropped — we disqualify residential anyway).
- In `scan-external-sources`, add query templates for the two new buckets, scoped to CA/NY/NJ/OR/HI only:
  - `pending_sale`: LoopNet/Crexi/brokerage pages with "under contract" / "pending" for commercial > $2M
  - `recent_close`: brokerage press releases + LoopNet "Sold" filters, last 30 days, commercial > $2M
- Keep Firecrawl `fc_reserve` gating unchanged.

## Files touched
- migration: add `days_until_45_deadline`, `days_until_180_deadline` to `leads`; add `city_surcharges` jsonb to `state_tax_rates`
- data update: seed `city_surcharges` for the 5 cities above
- `supabase/functions/qualify-lead/index.ts` — deadline math + city surcharge lookup
- `supabase/functions/draft-outreach-step/index.ts` — include deadlines in prompt
- `supabase/functions/scan-external-sources/index.ts` — new bucket templates
- `run_scout_cron()` — updated source array
- `src/components/OutreachDashboard.tsx` (+ possibly `LeadDrawer.tsx`) — deadline chips

## Out of scope (saved for Tier 2+)
- SEC 8-K disposition scanner
- LoopNet/Crexi listing-status watcher with auth
- Probate court scanning
- Second-pass decision-maker discovery
- NV replacement-inventory table

## After deploy
Trigger `run_scout_cron()` once + re-qualify existing CA/NY/NJ leads so the new deadlines and city surcharges populate immediately.