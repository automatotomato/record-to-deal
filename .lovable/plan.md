# AI 1031 Deal Finder — Product Overhaul

## 1. Automatic enrichment pipeline (no manual buttons)

Today, `verify-property → qualify-lead → enrich-contact → draft-outreach` already auto-chain via `pipeline_jobs`, but `seller-discovery` and `lead-brief` are only triggered by drawer buttons. Wire them into the same auto-chain:

- After `enrich-contact` finishes, if there is no usable email/phone, automatically enqueue a `seller_discovery` job (Apollo + Firecrawl + web fallbacks) instead of stopping at "needs_review".
- After `seller-discovery` finishes (success OR partial), automatically enqueue a `lead_brief` job so every qualified lead gets an AI brief without the user clicking.
- Register both `seller_discovery` and `lead_brief` as kinds in `job-dispatcher` (with sensible concurrency caps).
- Backfill: a one-shot job that enqueues `seller_discovery` + `lead_brief` for every existing lead missing contact/brief.

The drawer's "Find contact info" and "Generate brief" buttons stay, but only as secondary "Refresh research / Regenerate brief" fallbacks.

## 2. Lead readiness model

Add a single source of truth for client-facing status, computed by a DB trigger on every `leads` UPDATE so the UI never has to recalc:

New column `readiness` (text), one of:
- `researching` — pipeline still running
- `needs_contact_info` — has owner + reason but only LinkedIn / mailing addr (no email/phone)
- `contact_found` — has email or phone but brief not generated yet
- `ready_for_outreach` — has property, owner, reason, contact person, AND verified/likely email or phone, AND ai_brief
- `needs_manual_review` — enrichment exhausted, partial data, human required
- `low_confidence` — score/confidence below threshold

Critical rule (per request): LinkedIn alone NEVER counts as a usable contact. Only `decision_maker_email` (unlocked) or `decision_maker_phone`/`contact_phone` (≥10 digits) qualify.

## 3. Stronger contact fallback chain

Extend `seller-discovery` (and the auto-retry path) so it does not stop at LinkedIn. Order of attempts when email/phone missing:

1. Apollo `/people/match` by LinkedIn URL
2. Apollo by person name + company
3. Apollo by company domain → officers
4. Firecrawl scrape of company website `/contact`, `/about`, `/team`, `/leadership`
5. Firecrawl Google search: `"Owner Name" email OR phone "Company"`
6. OpenCorporates / SoS officers lookup for the entity
7. Common email-pattern guesses against the verified domain (first.last@, flast@, first@)
8. OpenAI extraction pass over collected page text to pull any email/phone strings

LinkedIn URL is always saved as supporting context; readiness stays `needs_contact_info` until step 1–8 yields email or phone.

## 4. Redesigned lead drawer (client-ready brief)

Replace the current top-down dump with an ordered, hide-when-empty layout:

1. **AI Deal Brief** (from `ai_brief`)
   - Summary · Why this is a good 1031 lead · How to approach · Best next action
2. **Contact Card** — only fields with real data
   - Name, role, email, phone, LinkedIn, company website
3. **Property Snapshot** — address, type, sale date + recency, sale price, owner/entity, state-tax flag
4. **1031 Fit Score** — score, top 3 reasons, confidence, red flags (only if any)
5. **Research Sources** — collapsed `<details>` containing public records, OpenCorporates, deed links, Google/LinkedIn searches, related entities, raw enrichment payload, mailing address from county

Helper rule: a `<Field>` / `<Section>` component returns `null` when its value is empty, "N/A", or a placeholder. No empty rows, no blank sections.

Manual fallback buttons ("Refresh Research", "Regenerate Brief", "Re-find contact") move into a small overflow menu in the drawer header.

## 5. Dashboard as an intelligence desk

`OutreachDashboard` becomes status-grouped sections (collapsible cards) instead of a single filtered table:

- Urgent Opportunities (sold ≤30 days)
- Ready for Outreach
- High-Value Leads (top tax exposure, any status)
- Contact Found (brief pending)
- Needs Contact Info
- Needs Review
- Recently Found

Each lead card shows: property · owner · score · readiness pill · contact availability icons (✉ ☎ in/—) · one-line `ai_brief.why_good` excerpt.

Existing filters/search remain in a toolbar above the sections.

## 6. Persistence & regeneration

`ai_brief` and `seller-discovery` results are already saved to the lead row. Reads in the drawer use the stored values; the edge functions are only re-invoked via the explicit "Refresh / Regenerate" actions or the auto-pipeline when a lead is first created.

---

## Technical section

**DB migration**
- `leads.readiness text not null default 'researching'`
- Trigger `compute_lead_readiness()` on `BEFORE UPDATE` of leads recomputes readiness from `pipeline_stage`, `has_outreach_contact`, `decision_maker_email/phone`, `contact_phone`, `ai_brief`, `score`, `enrichment_confidence`.
- Index `leads(readiness, is_urgent desc, score desc)`.

**Edge functions**
- `enrich-contact/index.ts`: when `!hasOutreach`, also `insert pipeline_jobs { kind: 'seller_discovery', priority: 50 }`.
- `seller-discovery/index.ts`: accept `{ job_id }` shape, on finish always `insert pipeline_jobs { kind: 'lead_brief' }`. Add fallback steps 4–8 above.
- `lead-brief/index.ts`: accept `{ job_id }` shape (alongside existing `{ lead_id }`).
- `job-dispatcher/index.ts`: add `{ kind:'seller_discovery', fn:'seller-discovery', cap:5 }` and `{ kind:'lead_brief', fn:'lead-brief', cap:10 }`.
- One-shot `backfill-enrichment` function (admin-only) to enqueue jobs for existing leads.

**Frontend**
- `LeadDrawer.tsx`: rewrite render tree to the 5-section order; introduce `<Field>`/`<Section>` helpers that suppress empty values; move manual actions to a header dropdown.
- `OutreachDashboard.tsx`: replace single table with `<ReadinessSection>` cards driven by `readiness` groupings; new `<LeadCard>` component with the one-line brief excerpt and contact icons.
- Status pill component reused in both drawer header and lead cards.

**Out of scope**
- No removal of existing enrichment data or public-record links (kept under "Research Sources").
- No backend behavior changes to email sending or Gmail flow.
