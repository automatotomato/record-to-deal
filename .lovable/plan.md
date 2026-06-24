## Goal

Stop bleeding Firecrawl credits and AI calls on leads we've already failed to enrich. Get net-new pre-sale opportunities flowing. No top-up required.

## Why this is happening

Yesterday's 8k Firecrawl burn + 8,552 AI 429s came from three holes:

1. **No per-lead cooldown.** When `seller-discovery` or `enrich-contact` fail to find a real email/phone, the lead falls back to `queued`/`retry` and gets picked up again on the next sweep — same lead, same searches, same credits.
2. **Per-call budget exists, per-day budget doesn't.** `seller-discovery` caps at 15 Firecrawl calls *per lead invocation*, but a lead can be invoked many times a day. Nothing stops a single stuck lead from burning hundreds of credits across retries.
3. **`profile_seller` retries on 429.** When the AI gateway rate-limits, the worker re-queues and re-fires immediately. That's where the 8,552-fail loop comes from.

The Pre-sale tab is empty because nothing inserts `pre_sale_prospect` rows — `scan-external-sources` only emits closed/recorded leads.

## What changes

### 1. Per-lead cooldowns (kills the loop)

- Add `leads.last_discovery_attempt_at` and `leads.discovery_attempt_count`.
- `seller-discovery` and `enrich-contact` refuse to run on a lead that:
  - Was attempted in the last **72 hours** with `discovery_status` in `partial`/`failed`, OR
  - Has been attempted **≥ 4 times total** without producing a real contact → mark `pipeline_stage = 'needs_review'`, `readiness = 'needs_manual_review'`, stop touching it.
- `pipeline-sweeper` skips these when re-queueing.

This alone stops re-scanning the same ~50 leads day after day.

### 2. Daily Firecrawl ceiling per caller

- New table `firecrawl_daily_budget(caller text, day date, credits_used int)`.
- Update `fc_reserve()` to reject when today's spend for that caller exceeds a cap:
  - `seller-discovery`: 300/day
  - `enrich-contact`: 200/day
  - `scan-sources`: 400/day
  - `scan-external-sources`: 300/day
  - `wealth-scan`: 100/day
- Total hard ceiling ~1,300/day. When a caller hits its cap, it logs `throttled: daily cap` and skips the call (no retry storm).

### 3. URL-level dedupe cache

- New table `firecrawl_url_cache(url text primary key, last_fetched_at timestamptz, caller text)`.
- Every Firecrawl `scrape`/`search` result URL is recorded. Re-fetching the same URL within **14 days** is a cache hit — no credit spent.
- Already partially done in `scan-sources` via `last_seen_source_urls`; extend to all five callers.

### 4. Fix the profile_seller 429 storm

- Switch model from current default to **`google/gemini-3-flash-preview`** (cheaper, higher rate limit).
- Add exponential backoff: on 429, re-queue with `run_after = now() + (2^attempts * 30s)` capped at 30 min, max 3 attempts then `failed`.
- Concurrency cap: only 2 `profile_seller` jobs running at once (claim_jobs already supports this — lower the dispatcher's batch size for this kind).

### 5. Pre-sale source: Crexi + LoopNet scrape

- Add a new `scan_presale` job kind in `run_scout_cron` (once/day per state).
- New edge function `scan-presale`:
  - Firecrawl `search` against `site:crexi.com "for sale" investment property <state>` and `site:loopnet.com "for sale" <state>`, time-filtered to last 30 days.
  - Each unique listing → insert lead with `pipeline_stage = 'pre_sale_prospect'`, `readiness = 'researching'`, source tagged `crexi`/`loopnet`.
  - Subject to the same 300/day cap (item 2) and URL cache (item 3).
- Pre-sale leads are NOT eligible for `seller-discovery` until a human moves them forward (avoids burning contact-hunt credits on listings that may never close).

## Technical details

**Migrations**
```sql
alter table public.leads
  add column if not exists last_discovery_attempt_at timestamptz,
  add column if not exists discovery_attempt_count int not null default 0;

create table public.firecrawl_daily_budget (
  caller text not null,
  day date not null default current_date,
  credits_used int not null default 0,
  primary key (caller, day)
);
grant select, insert, update on public.firecrawl_daily_budget to service_role;
alter table public.firecrawl_daily_budget enable row level security;
-- service-role only, no end-user policies

create table public.firecrawl_url_cache (
  url text primary key,
  last_fetched_at timestamptz not null default now(),
  caller text not null
);
grant select, insert, update on public.firecrawl_url_cache to service_role;
alter table public.firecrawl_url_cache enable row level security;
```

`fc_reserve()` gains a `(caller, daily_cap)` lookup and writes to `firecrawl_daily_budget`.

**Files touched**
- `supabase/migrations/<new>.sql` — schema above
- DB function `fc_reserve` — daily caps + url-cache check signature
- `supabase/functions/_shared/firecrawl.ts` (new) — single wrapper around scrape/search that consults `firecrawl_url_cache` and `fc_reserve`
- `supabase/functions/seller-discovery/index.ts` — cooldown check + use shared wrapper
- `supabase/functions/enrich-contact/index.ts` — same
- `supabase/functions/scan-sources/index.ts` — same
- `supabase/functions/scan-external-sources/index.ts` — same
- `supabase/functions/wealth-scan/index.ts` — same
- `supabase/functions/profile-seller/index.ts` — model swap + 429 backoff
- `supabase/functions/pipeline-sweeper/index.ts` — respect cooldown / attempt cap
- `supabase/functions/scan-presale/index.ts` (new)
- `run_scout_cron` DB function — enqueue `scan_presale` per state
- `src/components/OutreachDashboard.tsx` — surface `discovery_attempt_count` on the lead card so it's visible when a lead is "parked"

## Expected outcome

- Worst-case daily Firecrawl spend bounded at ~1,300 credits.
- A failed lead stops costing money after 4 attempts and shows up in **Needs Review** instead of cycling.
- `profile_seller` failure rate drops from thousands/week to near zero.
- Pre-sale tab starts populating from Crexi/LoopNet within one cron cycle.

## What this plan does NOT do

- No Firecrawl top-up requested.
- No new paid data API (ATTOM/Estated) — explicitly skipped per your direction.
- No change to the closing-scout adapter for Travis County.
