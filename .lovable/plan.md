
# Dashboard Redesign with shadcn

Rebuild the visual layer of the Outreach Desk using standard shadcn components. Keep all data fetching, filtering, sorting, realtime, scout-run, export, and lead-drawer logic exactly as-is — only the markup and styling change.

## What changes

### 1. App shell → shadcn Sidebar
Replace the hand-rolled `<aside>` in `src/components/AppShell.tsx` with the shadcn `Sidebar` system:
- `SidebarProvider` wrapping the layout
- `Sidebar` (collapsible="icon") with `SidebarHeader` (logo + brand), `SidebarContent` → `SidebarGroup` → `SidebarMenu` for nav (Outreach, Sources), and `SidebarFooter` (user email + sign out via `DropdownMenu`)
- Persistent `SidebarTrigger` in a top header bar inside `<main>` so it's always visible
- Active route via `NavLink` + `isActive` styling on `SidebarMenuButton`

### 2. Outreach dashboard → shadcn primitives
Rewrite `src/components/OutreachDashboard.tsx` markup using:
- **Header**: cleaner page header (title + subtitle + action `Button`s grouped on the right). Drop the all-caps mono "industrial" treatment in favor of standard shadcn typography.
- **KPI strip**: 4 `Card` components in a `grid` with `CardHeader`/`CardTitle` (label) and `CardContent` (big tabular number). Tooltips preserved.
- **Tabs**: shadcn `Tabs` / `TabsList` / `TabsTrigger` for "1031 Candidates" / "All active leads" with count `Badge`s.
- **Toolbar**: shadcn `Input` (with leading `Search` icon) + `Popover`-based filter sheet (kept), plus a results-count caption on the right. Active filters surface as removable shadcn `Badge` chips below the toolbar.
- **Table**: shadcn `Table` / `TableHeader` / `TableRow` / `TableCell`. Rows hover-highlight, click opens drawer. Tier shown as colored `Badge` (variant by tier). Status as `Badge` with dot. Window pill as `Badge` variant. Seller-contact icons stay but use `Tooltip` + muted/foreground colors via `Badge variant="outline"` cluster.
- **Empty / loading**: shadcn `Card` with centered content + `Skeleton` rows for loading state.
- **Lead drawer**: untouched (already a `Sheet`).

### 3. Tier / status badge variants
Add a small helper (inline in the file) that maps:
- tier → badge classes (URGENT=destructive, HOT=red-ish, WARM=amber, UNSCORED=secondary)
- status → dot color + label
…using existing tokens from `src/index.css` so colors remain consistent with the brand.

## What does NOT change
- All queries, mutations, realtime subscriptions, filter logic, sorting, export, scout-run, candidate detection.
- `LeadDrawer`, `TouchpointTimeline`, `NextActionEditor`, edge functions, DB schema.
- Routes, auth, admin gating.
- Brand color tokens in `index.css` (accent / hot / warm / urgent / cold). The redesign uses them through shadcn variants instead of bespoke utility classes.

## Files touched
- `src/components/AppShell.tsx` — rewrite with shadcn Sidebar
- `src/components/OutreachDashboard.tsx` — rewrite markup, keep all hooks/logic
- (no new deps; `@/components/ui/sidebar`, `tabs`, `card`, `badge`, `skeleton` are already installed under `src/components/ui/`)

## Visual direction
Modern shadcn default look: rounded corners (`rounded-md`, not `rounded-none`), standard sans typography (drop the heavy `font-mono uppercase tracking-widest` treatment for chrome — keep mono only for tabular numbers and IDs), generous spacing, subtle borders, `bg-card` surfaces, consistent `Badge` usage. Density stays comfortable for a data-dense table.
