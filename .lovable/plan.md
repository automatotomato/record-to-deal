## What actually changed (root cause)

Your "before" setup wasn't lost to credits — it was lost to a strategy change. Three things stacked up and killed yield:

1. **`scan-sources` was rewritten to a "recorder-deed-only" strategy.**
   - Old (May, when leads were flowing): 2 broad Google queries on LoopNet/Crexi/general web for "sold" investment properties, 4 results each, scraped. ~10 credits/county and consistently returned multiple candidates.
   - Now: 3 queries restricted to `site:.gov OR site:.us` and a deny-list of every major real-estate domain (LoopNet, Crexi, Zillow, Compass, KW, CBRE, JLL, etc.). County recorder sites aren't usefully indexed by Google, so these searches return ~0 results. We still pay the search credit, get nothing, and the AI extractor returns an empty list.

2. **The `compute_lead_readiness` trigger was tightened.** Anything with a broker-pattern owner name, broker email domain, or generic inbox now flips to `low_confidence` / `needs_manual_review`. So even when a Crexi/LoopNet lead does slip through, it gets parked instead of surfaced.

3. **`scan-external-sources` scrapes every search result** (~7 credits per query at limit=6). It runs against the same broker/SEC/court sites that don't expose owner contact info in their markdown, so the AI extractor returns empty. Lots of credits, ~0 leads.

The new guardrails (daily caps, 14-day URL cache, 72h per-lead cooldown, parking after 4 attempts) are working as designed — they're throttling the bleed, which is why today's "actual credits done" is small. But the *yield* was already broken by the strategy change above. We've gone from "broad queries that returned leads cheaply" to "narrow queries that return nothing while still costing credits per call".

Lead-creation timeline confirms it:
```
May 25–31:  30 leads   ← old scan-sources, broad queries
Jun 1–6:    21 leads
Jun 7–22:    0 leads   ← rewrite period
Jun 23–24:   6 leads   ← only because Travis County adapter still works
```

## Fix plan

### 1. Revert `scan-sources` to broker-friendly broad queries
Replace the recorder-deed strategy with the original 2-query pattern. Keep the new dedupe + cache + daily cap.

- Queries: the old `{county} ("investment property" OR multifamily OR NNN ...) sold "$" (LLC OR Trust ...)` + `site:loopnet.com OR site:crexi.com {county} {state} sold`.
- Remove `BROKER_DENY_HOSTS` from the URL filter (keep it only as a soft signal for "owner name looks like a broker", not as a hard `-site:` filter).
- Drop scraping inside search — use just snippets/descriptions for AI extraction. Saves ~5 credits per query.
- Keep `MAX_RESULTS_PER_QUERY=4`, 2 queries → ~2 credits/county instead of ~12.

### 2. Loosen `compute_lead_readiness` trigger
- Broker-name / broker-domain matches → still allowed to reach `contact_found` (with a warning flag), instead of forcing `low_confidence`.
- Only force `low_confidence` when the lead has NO owner, NO address, AND looks like a broker page.
- This rescues the leads scan-sources will start producing again.

### 3. Cut `scan-external-sources` cost per call
- Drop `scrape: true` from `fcSearch` — use the search snippet only. The AI extractor was getting almost nothing useful from the markdown anyway.
- Lowers per-call cost from ~7 credits to 1.
- Keep all 5 source families (commercial, residential, court, sec, pending_sale) and the daily 300-cap budget.

### 4. Keep the new guardrails — they're correct
- Daily per-caller caps, monthly cap, URL cache, per-lead cooldown, profile_seller backoff: all stay.
- The presale scan stays (still on Crexi/LoopNet).

### 5. Backfill what's currently parked
- One-time SQL: any lead currently in `needs_review` / `low_confidence` whose only failure was the broker filter → re-set to `enriched` so the loosened trigger re-evaluates them on next update.

## Files

- `supabase/functions/scan-sources/index.ts` — revert query strategy, drop scrape, drop site deny-list.
- `supabase/functions/scan-external-sources/index.ts` — `scrape: false`.
- `supabase/migrations/<new>.sql` — update `compute_lead_readiness()`; one-time UPDATE to re-evaluate parked leads.

## What I'm NOT doing

- Not touching the daily cap, monthly cap, URL cache, cooldown, presale scan, or profile-seller backoff.
- Not adding a new data source or paid API.
- Not topping off Firecrawl.

## Expected outcome

- scan-sources cost drops from ~12 credits/county to ~2 credits/county.
- scan-external-sources cost drops from ~7 credits/query to ~1.
- Lead yield returns to ~5–10 new leads/county/run, like late May.
- Total daily Firecrawl burn stays well under the 1,300 ceiling.
