## Cleanup Plan

Remove dead code, broken references, and stale artifacts left over from earlier iterations (multi-state focus, A/B/C/D tier system, never-built edge functions, etc.). No feature changes — purely housekeeping.

### 1. Remove broken / stale code in components

**`src/components/LeadDrawer.tsx`**
- Remove the **Send via Gmail** button + `sendEmail` flow + `send-outreach-email` invocation. That edge function was never built — clicking Send currently throws.
- Remove the email composer UI (`toEmail`, `emailSubject`, `emailBody` state, `Input`/`Textarea` block) since without send it's pointless. Keep the AI draft preview as read-only text, or drop the whole "Outreach" section.
- Remove CA/IL-specific reference links in `ReferenceLinks` (LA Assessor, LA Recorder, Cook County Assessor, Cook County Recorder). Replace with Nevada equivalents (Clark County Assessor / Washoe County Assessor) or just leave the generic Google/LinkedIn/OpenCorporates lookups.
- Remove obsolete `A`/`B`/`C`/`D` keys from `TIER_DESCRIPTIONS` (tiers are now `URGENT/HOT/WARM/COLD/DISQUALIFIED/UNSCORED`).
- Remove unused imports (`Send`, etc.).

**`src/components/OutreachDashboard.tsx`**
- Remove the `findSellersBulk` action and its dropdown item — Admin's `profileAllUnprofiled` already does this, and the qualifier auto-profiles every new lead. Keeps the "More" dropdown to just **Export CSV**.
- Remove related state (`profiling`, `profileProgress`) and the progress bar.
- Remove unused imports (`Sparkles`, `DropdownMenuSeparator`).

**`src/pages/Admin.tsx`**
- Fix the county-toggle switch: replace `["la_county", "cook_county"]` whitelist with the actual NV parser keys (`clark_county`, `washoe_county`) so admins can toggle the counties that matter.
- Update the helper caption ("Only Los Angeles and Cook…") to reflect Nevada coverage.
- Remove unused imports (`Sparkles`, `Target`).
- Remove leftover `data?.tier_a`/`tier_b` toast (qualifier returns `tier_urgent`/`tier_hot`/`tier_warm` now).

### 2. Delete unused files

- `src/components/NavLink.tsx` — wrapper that nothing imports (`AppShell` uses `NavLink` from `react-router-dom` directly).
- `src/App.css` — Vite default boilerplate; not imported anywhere (project uses `index.css`).

### 3. Delete unused shadcn/ui components

These have zero imports outside their own files:
`accordion`, `alert`, `alert-dialog`, `aspect-ratio`, `avatar`, `breadcrumb`, `calendar`, `carousel`, `chart`, `checkbox`, `collapsible`, `command`, `context-menu`, `drawer`, `form`, `hover-card`, `input-otp`, `menubar`, `navigation-menu`, `pagination`, `radio-group`, `resizable`, `scroll-area`, `slider`, `tabs`, `toggle`, `toggle-group`, `sidebar` (custom sidebar in `AppShell`).

Keep: `button, input, select, dropdown-menu, sheet, switch, progress, textarea, table, badge, card, dialog, label, popover, separator, skeleton, sonner, toast, toaster, tooltip, use-toast`.

### 4. Remove unused npm dependencies

After step 3, remove from `package.json`:
- `@radix-ui/react-accordion`, `react-alert-dialog`, `react-aspect-ratio`, `react-avatar`, `react-checkbox`, `react-collapsible`, `react-context-menu`, `react-hover-card`, `react-menubar`, `react-navigation-menu`, `react-radio-group`, `react-scroll-area`, `react-slider`, `react-toggle`, `react-toggle-group`
- `cmdk`, `date-fns`, `embla-carousel-react`, `input-otp`, `next-themes`, `react-day-picker`, `react-resizable-panels`, `recharts`, `vaul`
- `@hookform/resolvers`, `react-hook-form`, `zod` (no forms in project)
- `@tailwindcss/typography` (no `prose` usage)

### 5. Database / edge function cleanup

- No edge functions to delete from Supabase (only `scout-run`, `qualifier-run`, `profiler-run` exist and are all in use).
- No table changes — `outreach_emails` table stays in case email-send is re-added later.

### 6. Out of scope

- No behavior changes to scout/qualifier/profiler logic.
- No styling/theme changes.
- Outreach email feature is left removed; if you want it back later, we'd build the `send-outreach-email` edge function fresh.

### Files touched

Edited: `src/components/LeadDrawer.tsx`, `src/components/OutreachDashboard.tsx`, `src/pages/Admin.tsx`, `package.json`
Deleted: `src/components/NavLink.tsx`, `src/App.css`, ~28 files in `src/components/ui/`