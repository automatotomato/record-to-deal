
# Why the dashboard fields are blank

The qualifier function is producing tier letters `"A" / "B" / "C" / "D"`, but the database `lead_tier` enum only accepts `URGENT / HOT / WARM / COLD / DISQUALIFIED / UNSCORED`. Every score update has been silently failing with:

```
invalid input value for enum lead_tier: "C"
```

That is why **tier, score, tax exposure, owner, and mailing all show "—"** — the qualifier never successfully writes anything, so the profiler is never triggered for the leads.

This is a real bug, not a workflow problem. Once it's fixed, the existing scout chain (scout → qualifier → profiler → re-score) will populate everything in one click.

# What I'll change

## 1. Fix the tier enum bug (the actual root cause)

In `supabase/functions/qualifier-run/index.ts`, map the internal letters to the real enum values:

| Score    | Tier            |
|----------|-----------------|
| ≥ 70     | `HOT`           |
| ≥ 50     | `WARM`          |
| ≥ 30     | `COLD`          |
| < 30     | `DISQUALIFIED`  |
| `is_urgent` && score ≥ 50 | `URGENT` (overrides) |

Update all internal `tierA` / `tierB` references to `tierHot` / `tierWarm` / `tierUrgent` so the profiler fan-out keeps working.

## 2. Collapse the workflow to **one** button

Right now you have:
- Outreach: "Run Scout" + the overflow menu ("Re-enrich visible", "Export CSV")
- Sources (Admin): "Run Scout now", "Enrich + score with Smarty", checkboxes for counties

I'll simplify to a single primary button on Outreach: **"Find new leads"**.

That button runs the full chain end-to-end:
```
scout-run  →  qualifier-run  →  profiler-run (Smarty)  →  qualifier-run (re-score)
```

Live progress shows: `Scouting Nevada → Scoring 12 leads → Pulling owner data 5/12 → Done · 12 new leads`.

On the Sources/Admin page I'll remove the "Enrich + score with Smarty" button entirely — it's now redundant. Sources keeps only the county on/off checkboxes (configuration, not actions).

## 3. Clear the stale broken leads + re-run

After deploying the fix, I'll:
- Delete the existing leads (they all have `tier=UNSCORED` because the writes failed)
- Trigger one fresh scout run so you see the dashboard fully populated within ~60 seconds

# Files affected

- `supabase/functions/qualifier-run/index.ts` — tier enum mapping fix
- `src/components/OutreachDashboard.tsx` — single "Find new leads" button with inline progress
- `src/pages/Admin.tsx` — remove redundant "Enrich + score with Smarty" button
- Database: clear stale leads, kick off one scout run

# What you'll see after

One button. Click it. ~60 seconds later every row has a tier badge, a score, an owner name, a mailing address, and a tax exposure number.
