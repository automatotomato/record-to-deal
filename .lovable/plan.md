## Plan to fix lead discovery

### What I found
- The **Find new leads** button in `OutreachDashboard` still inserts `scan_sources` jobs **without `payload: {}`**, which can trigger the not-null payload error even though the Admin page was already patched.
- The button can enqueue a large batch of county + external scans at once, causing **Firecrawl throttling** and credit burn.
- Recent database state shows the pipeline is creating some leads, but very few visible/new qualified leads, while many Firecrawl calls are being throttled.

### Fixes I will implement
1. **Fix the button enqueue bug**
   - Add `payload: {}` to every `scan_sources` row created by the Find new leads button.
   - Make the success toast accurately say county/external scans, not only county scans.

2. **Stop runaway credit usage**
   - Limit manual scan dispatch to a small, high-priority batch instead of queuing every enabled source at once.
   - Reduce dispatcher concurrency for Firecrawl-heavy scan workers so manual scans don’t flood the Firecrawl gate.

3. **Make scan failures visible instead of silent**
   - Surface worker results/errors in the recent scan status so the app shows when scans are skipped, throttled, missing credentials, or finding zero candidates.
   - Keep this focused on the existing dashboard/admin UI; no new backend product surface.

4. **Keep the pipeline moving safely**
   - Ensure follow-up jobs inserted by scan workers include non-null payloads.
   - Keep auto-dispatch behavior, but at lower concurrency to avoid credit spikes.

5. **Validate after changes**
   - Check the source files for the enqueue paths.
   - Run a read-only database check to confirm new queued jobs have payloads and inspect scan results/errors after the fix is live.

### Expected outcome
- Clicking **Find new leads** should no longer throw the payload error.
- Manual scans should consume credits more slowly and predictably.
- If scans still find zero leads, the UI/database will show why instead of appearing broken.