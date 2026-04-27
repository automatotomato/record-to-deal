## Goal

Make The Desk feel like a single, obvious workflow:
**Find leads → Review urgent ones → Open a lead → Draft outreach.**

No jargon. One clear primary action at any moment. Everything else tucked away.

## What changes (user-facing)

### 1. Header — one primary action, plain language

Current header has "Find new leads" + a "More" dropdown for export. It's small and looks decorative.

New header:
- Big title stays ("The Desk").
- A short helper line under it: e.g. *"148 leads · 12 urgent · last refreshed 2h ago"* — replaces the "Outreach pipeline · Live feed" eyebrow.
- One **prominent primary button**: **`+ Find new leads`** (orange, larger, with a tooltip: *"Scans Nevada county records for fresh investment property sales"*).
- Secondary button: **`Export CSV`** (visible, not buried in a dropdown).
- "Sources" admin button moved to header (admin only) so admins don't hunt for it in the sidebar.

### 2. KPI strip — fewer, friendlier

Today: 6 KPIs, some are jargon ("Avg score", "Data quality").

New: 4 KPIs, each with a 1-line description on hover:
- **Total leads** (all time)
- **Urgent** *(sold in the last 30 days — 1031 clock is ticking)*
- **Hot leads** *(strongest 1031 candidates)*
- **Pipeline tax exposure** *(combined estimated tax bill across all leads)*

Drop "Avg score" and "Data quality" — they're internal metrics, not client-actionable.

### 3. Tabs — clearer labels, one default view

Current: `Active leads / Cold / Disqualified`.

New labels (clearer intent):
- **`Worth pursuing`** *(URGENT + HOT + WARM + UNSCORED)* — default
- **`Low priority`** *(COLD)*
- **`Filtered out`** *(DISQUALIFIED — explains in tooltip: "Owner-occupied homes, too small, etc.")*

Each tab keeps its count badge.

### 4. Filters — collapse into one row, hide noise

Current: 3 select dropdowns + search, all visible.

New:
- Search bar stays, full width on the left, with placeholder *"Search by owner, address, or city"*.
- A single **`Filters`** button opens a popover with Tier / State / Status filters. A small badge shows how many filters are active.
- Removes visual clutter; advanced users still get the same controls.

### 5. Lead table — clearer columns, scannable

Same data, friendlier headers and small cleanups:
- `Tier` → `Priority`
- `Score` → removed from default view (it's an internal number — moved to lead drawer)
- `Type` → `Property type`
- `Mailing address` → `Owner mailing` with a small "no address" badge instead of an em-dash when missing
- `Sold` → `Last sale`
- `Status` column: replace text with a colored dot + label (e.g. green dot "New", grey dot "Contacted") — easier to scan
- Add a subtle row hover hint: *"Click to open lead"* on first hover only.

### 6. Empty state — guides next step

Current empty state mentions "Los Angeles and Cook counties" (stale copy from before NV pivot).

New empty state:
- Headline: *"No leads yet."*
- Subline: *"Click 'Find new leads' to scan Nevada county records for recent investment property sales. This usually takes 1–2 minutes."*
- Big primary button to run the scout.

### 7. Lead drawer — one clear next action

Currently has two near-identical buttons: "Find seller info" in the Seller section AND "Profile + draft email" in the AI section, both calling the same function. Confusing.

Fix:
- Remove the duplicate button in the Seller section.
- Rename the single action to **`Find owner & draft email`** (action verb, plain language).
- Once data exists, the button becomes **`Refresh & re-draft`**.
- Move the "Workflow / Status" section to the **top** of the drawer so changing status is one click after opening.

## What stays the same

- Editorial typography, color palette, dense data feel — only labels and layout improve.
- All scout / qualifier / profiler logic is untouched.
- Realtime updates, CSV export, drawer content all preserved.

## Technical scope

Files edited:
- `src/components/OutreachDashboard.tsx` — header restructure, KPI changes, tab labels, filter popover, table column updates, empty-state copy.
- `src/components/LeadDrawer.tsx` — remove duplicate action button, rename primary CTA, move Workflow section to top.
- `src/components/AppShell.tsx` — minor: keep "Sources" in sidebar for admins (no change needed if header link added).

No database, edge function, or schema changes. No new dependencies.
