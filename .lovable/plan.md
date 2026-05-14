## Cleanup audit — what's broken, stale, or unneeded

I went through every edge function, the dispatcher/sweeper wiring, and the dashboard references. Here's what I found.

---

### 1. Actively broken (causing runtime errors right now)

**`scan-external-sources` — ReferenceError on every run.**
Logs show: `ReferenceError: HARD_BUDGET_MS is not defined at index.ts:340:30`. The function references `HARD_BUDGET_MS` on line 323 inside the main loop, but the constant is never declared. Every external-source scan is failing.

Fix: add `const HARD_BUDGET_MS = 90_000;` (or similar) near the top of the file with the other constants.

---

### 2. Stale / superseded code (works, but no longer needed after Track 4)

**`draft-outreach` (the legacy single-shot drafter).**
Track 4 replaced it with `draft-outreach-step` + `outreach-cadence-tick` (multi-touch sequences). The old function is still wired in:

- `supabase/functions/job-dispatcher/index.ts` line 22 — still dispatches `draft_outreach` jobs
- `supabase/functions/pipeline-sweeper/index.ts` line 85 — sweeper still enqueues `draft_outreach` for stuck leads
- `supabase/functions/seller-discovery/index.ts` line 720 — discovery enqueues `draft_outreach` after qualification
- `src/components/LeadDrawer.tsx` line 109 — manual "draft" button enqueues the old kind
- `src/components/PipelineHealthCard.tsx` line 106 — health widget shows `draft_outreach` column

Result: every qualified lead currently gets BOTH a one-shot `draft-outreach` email AND step 1 of a sequence — duplicate drafts piling up in `outreach_emails`.

Recommendation: pick one of these two (your call):
- **(A) Delete `draft-outreach` entirely.** Remove the function, drop it from dispatcher/sweeper/seller-discovery/LeadDrawer/PipelineHealthCard, and have the manual "draft" button enqueue `draft_outreach_step` instead. Cleanest.
- **(B) Keep `draft-outreach` only as the manual "draft now" button** in LeadDrawer, and remove its automatic enqueue from sweeper + seller-discovery + dispatcher cron.

I'd recommend **(A)** — sequences cover the same use case and avoid the duplicate-draft problem.

---

### 3. Stale UI references

**`PipelineHealthCard.tsx` line 106** lists job kinds `["scan_county", ...]` — but `scan_county` has never existed as a job kind. The real kinds are `scan_sources` and `scan_external`. The widget's "scan_county" column is always 0. Replace with `scan_sources` and `scan_external`.

---

### 4. Scaffolded-but-disabled (keep, you already decided)

**`poll-email-replies/index.ts`** — has `const ENABLED = false;` and short-circuits. You explicitly asked to keep it disabled in an earlier turn. Leave as-is.

---

### 5. Things I checked and they're fine

- All other edge functions (`enrich-contact`, `lead-brief`, `profile-seller`, `wealth-scan`, `verify-property`, `qualify-lead`, `seller-discovery`, `scan-sources`, `send-outreach-email`, `outreach-cadence-tick`, `draft-outreach-step`, `pipeline-sweeper`, `job-dispatcher`) are referenced and used.
- No orphan files in `src/components/`.
- Migrations all look applied and consistent.

---

### Proposed cleanup steps (if you approve)

1. Fix `HARD_BUDGET_MS` in `scan-external-sources` — 1 line.
2. Delete `supabase/functions/draft-outreach/` and call `delete_edge_functions` to remove the deployed copy.
3. Strip `draft_outreach` from `job-dispatcher`, `pipeline-sweeper`, `seller-discovery`.
4. Update `LeadDrawer.tsx` manual button to enqueue `draft_outreach_step`.
5. Fix `PipelineHealthCard.tsx` job-kinds list (`scan_county` → `scan_sources`, `scan_external`; `draft_outreach` → `draft_outreach_step`).

No DB migration needed — no schema changes, only code.

Say "go" (or pick option B for #2–4) and I'll implement.