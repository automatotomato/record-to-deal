# Pipeline Completion — Final Round (sweeper + admin visibility)

Quick audit: most of what we planned for §1 and §2 is already in code from the prior round.

| Item | Status |
|---|---|
| Qualifier removes 500-cap, pages all leads | ✅ done |
| Urgency rule (high-tax + investor signal, NV secondary) | ✅ done |
| Tax math split: fed / state / recapture | ✅ done |
| Profiler always writes an `outreach_emails` draft (templated fallback) | ✅ done |
| `pipeline_stage` advances `discovered → scored → profiled → enriched → drafted → ready` | ✅ done |
| Profiler concurrency 3→5 | ✅ done |
| **Pipeline sweeper to catch stragglers** | ❌ to build |
| **Admin visibility into stuck-at-stage backlog** | ❌ to build |

So this round is just the safety net + visibility. Wealth signals (§3) explicitly skipped per your call.

---

## A. New `pipeline-sweeper` edge function

Daily cron job. Runs in this order:

1. Find leads with `tier = 'UNSCORED'` → invoke `qualifier-run` with their IDs.
2. Find leads with `pipeline_stage IN ('scored','profiled')` AND `tier IN ('URGENT','HOT','WARM','COLD')` AND `decision_maker_email IS NULL` → invoke `profiler-run` with `force=true`, concurrency 5.
3. Find leads with `pipeline_stage IN ('enriched','profiled')` AND no row in `outreach_emails` → invoke `profiler-run` with `force=true` (profiler always writes a draft now).
4. Log a `lead_activities` row per re-run with `kind='sweeper_rerun'` and the reason.
5. Return a summary: `{ rescored, reprofiled, redrafted }`.

Caps per run: 200 leads per stage to keep Apollo/Firecrawl spend predictable. Rest picked up next night.

**Cron:** pg_cron, 03:00 UTC daily, calls the function via `net.http_post` with the anon key.

**Config:** register in `supabase/config.toml` with `verify_jwt = false`.

---

## B. Admin: pipeline backlog UI

Add a "Pipeline health" section to `/admin` above the counties table.

```text
┌─────────────────────────────────────────────────────────────┐
│ PIPELINE HEALTH                              [Run sweeper] │
├─────────────────────────────────────────────────────────────┤
│ discovered    12  ─────                                     │
│ scored        47  ──────────                                │
│ profiled       8  ──                                        │
│ enriched      14  ────                                      │
│ drafted       31  ───────                                   │
│ ready        108  ████████████████████████                  │
│                                                             │
│ ⚠ 23 leads stuck >24h without advancing                    │
└─────────────────────────────────────────────────────────────┘
```

- Counts come from a single `select pipeline_stage, count(*) from leads group by pipeline_stage` query (TanStack Query, refetch every 30s).
- "Stuck" = `pipeline_stage != 'ready'` AND `updated_at < now() - interval '24 hours'`. Click → drawer listing them.
- "Run sweeper" button calls the new edge function; shows live progress toast.

---

## File-by-file

- `supabase/functions/pipeline-sweeper/index.ts` — **new**
- `supabase/config.toml` — register sweeper, `verify_jwt = false`
- pg_cron schedule via `supabase--insert` (so the function URL + anon key aren't baked into a migration)
- `src/pages/Admin.tsx` — add pipeline-health card + manual sweeper button
- `src/components/PipelineHealthCard.tsx` — **new** small component for the histogram + stuck-list drawer

No database schema changes needed — `pipeline_stage` and `state_tax_rates` already exist. State tax seed stays as-is per your call.

---

That's it. Smaller than the original plan because the prior round already landed most of it.
