### What I found

- Firecrawl is not the only issue: new lead rows have been created recently, including June 23 and June 24.
- Most `scan_sources` and `scan_external` jobs are completing with `found: 0` / `inserted: 0`, which points to extraction/search criteria being too strict or returning weak evidence.
- `scan_presale` jobs reported many inserts, but no `pre_sale_prospect` leads remain in the dashboard. Those rows are likely being removed/hidden by downstream qualification/cleanup logic or never passing the dashboard’s active lead query.
- The dashboard only shows leads that pass narrow filters: not disqualified, sale date within 60 days or no-sale-date created recently, and then tab/readiness/status filters.
- The qualifier currently deletes disqualified/expired leads entirely, which makes failed property intake invisible and makes it look like nothing was found.

### Plan

1. **Stop silently deleting found properties**
   - Change qualification so disqualified/expired leads are retained as `disqualified` / `expired` instead of being deleted immediately.
   - Keep them out of the main active opportunity list, but preserve them for audit/debugging.

2. **Preserve pre-sale prospects**
   - Ensure `pre_sale_prospect` leads are not accidentally removed by qualification or cleanup rules.
   - Keep pre-sale listings visible in the Pre-sale tab even when they do not have a sale date.

3. **Make scan outcomes visible**
   - Add richer job result details for scan jobs: raw candidates found, candidates dropped by reason, inserted count, duplicate count, and error count.
   - This will show whether jobs are failing, finding bad data, finding duplicates, or being filtered.

4. **Loosen over-strict external-source insertion**
   - `scan-external-sources` currently requires owner name, property address, source URL, and reachability before inserting.
   - For property intake, insert property candidates when they have a property address and source URL, even if contact info is missing.
   - Contact enrichment can happen later; lack of contact info should not block a new property from appearing.

5. **Fix dashboard visibility for newly found properties**
   - Add a clear “Found / Researching” surface or adjust the active query so newly inserted `raw_candidate`, `qualified`, `needs_review`, and `pre_sale_prospect` properties are visible before contact info is found.
   - Keep “Ready” focused on outreach-ready leads, but don’t hide new properties just because contacts are missing.

6. **Run one manual validation after implementation**
   - Trigger the existing daily scout/dispatcher once.
   - Verify job results show inserted or explicitly dropped properties.
   - Verify newly inserted properties appear in the dashboard or in a visible review/researching section.

### Technical details

- Likely files to update:
  - `supabase/functions/qualify-lead/index.ts`
  - `supabase/functions/pipeline-sweeper/index.ts`
  - `supabase/functions/scan-external-sources/index.ts`
  - `supabase/functions/scan-sources/index.ts`
  - `src/components/OutreachDashboard.tsx`
- No new always-running cron will be added.
- No Firecrawl key changes are needed.