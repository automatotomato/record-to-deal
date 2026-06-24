## Goal
Split the pipeline so leads with verified contact details (ready to call/email) live in a different view from leads where automated discovery failed and a human needs to step in.

## What changes (UI only)

**1. Replace the current tabs in `OutreachDashboard.tsx`**

Today's tabs: `1031 Candidates · Pre-sale · All active` (with a Readiness chip row underneath).

New tabs:

- **Ready to contact** — leads where `readiness IN ('ready_for_outreach', 'contact_found')` OR `decision_maker_email` / `decision_maker_phone` / `contact_phone` is present. These are the rows you can act on right now.
- **Needs review** — leads where `readiness IN ('needs_manual_review', 'low_confidence')` OR `discovery_status IN ('failed', 'partial')` with no contact. The pipeline gave up — a human has to finish the job.
- **Researching** — still in flight (`readiness = 'researching'` or pending discovery jobs). Informational, no action expected.
- **Pre-sale** — unchanged.
- **All active** — unchanged, becomes the fallback "show me everything" view.

Each tab shows a count badge so the split is visible at a glance.

**2. Remove the now-redundant "Quick view" readiness chip row** (Ready / Researching / Needs review) since the tabs do that job. Keep the Readiness option in the Filters popover for power users who want to combine it with state/priority filters.

**3. Default landing tab = "Ready to contact"** so the first thing the user sees is the actionable cohort, not a mixed list.

**4. Empty-state copy per tab:**
- Ready: "No leads ready for outreach yet — check back as discovery finishes."
- Needs review: "Nothing waiting on you. The pipeline is keeping up."
- Researching: "Discovery is idle — run a scan to find new leads."

**5. Row-level tweak:** in the "Needs review" tab, show *why* a lead landed there (missing email, missing decision-maker name, discovery failed) as a small muted line under the status pill, so reviewers know what to fix.

## What does NOT change

- No DB schema changes. The `readiness` column and `compute_lead_readiness()` trigger already classify every lead correctly — we're just surfacing those buckets as tabs.
- No edge-function or pipeline logic changes.
- KPI cards, header, scan button, export, filters popover, lead drawer — all untouched.

## Files touched

- `src/components/OutreachDashboard.tsx` — tab definitions, `TabKey` type, `isCandidate`/new predicates, `tabCounts`, default tab state, quick-view row removal, empty-state copy, "needs review" reason line.

That's the entire change.
