# One-shot database cleanup

Delete data the app no longer needs, in four passes. Runs once via the data-change tool — no schema changes, no new code.

## What gets deleted

**1. Stale leads (sale_date older than 30 days)**
- Target: `leads` where `sale_date < today - 30 days`.
- Pre-sale prospects (`sale_date IS NULL`) are preserved.
- Cascading deletes first on child tables: `lead_activities`, `lead_touchpoints`, `outreach_touches`, `outreach_emails`, `pipeline_jobs` (by `lead_id`).

**2. Disqualified / expired leads (any age)**
- Target: `leads` where `pipeline_stage IN ('disqualified','expired')` OR `tier IN ('DISQUALIFIED','EXPIRED')`.
- Same child-table cascade as above.

**3. Old pipeline_jobs**
- Target: `pipeline_jobs` where `status IN ('done','failed','cancelled')` AND `COALESCE(finished_at, locked_at, created_at) < now() - interval '7 days'`.
- Leaves queued/retry/running rows alone.

**4. Old telemetry**
- `scout_runs` where `started_at < now() - interval '30 days'`.
- `firecrawl_usage` where `started_at < now() - interval '30 days'`.

## Order of operations (single migration-free data change)

```text
1. children of stale-leads  → delete
2. stale leads              → delete
3. children of dq/expired   → delete
4. dq/expired leads         → delete
5. old pipeline_jobs        → delete
6. old scout_runs           → delete
7. old firecrawl_usage      → delete
```

Each step prints a row count so you see what went.

## Out of scope

- No schema changes, no new cron, no code edits. The existing sweeper already handles ongoing cleanup; this is a one-time catch-up.
- `counties`, `outreach_sequences`, `outreach_steps`, `state_tax_rates`, `system_settings`, `profiles`, `user_roles`, `paused_cron_jobs`, `client_feedback` are untouched.
