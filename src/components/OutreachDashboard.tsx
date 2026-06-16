import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { fmtMoney, fmtRelative, fmtDate, windowStatus } from "@/lib/format";
import {
  Loader2,
  Plus,
  Download,
  AlertCircle,
  Search,
  Mail,
  Phone,
  Link2 as Linkedin,
  Home,
  Settings2,
  SlidersHorizontal,
  X,
  Clock,
  Flame,
  TrendingUp,
  Briefcase,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { LeadDrawer } from "./LeadDrawer";


import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

type Lead = any;
type TabKey = "candidates" | "presale" | "active";
type OwnerRollup = { owner_key: string; property_count: number; total_sale_value: number; total_tax_exposure: number };


// Collapsed 3-tier priority system. The DB has CRITICAL/URGENT/ACTIVE/HOT/
// WARM/FOLLOW_UP/COLD/etc. — too many overlapping labels. We bucket them:
//   HOT  = act this week (urgent flag, or CRITICAL/URGENT/HOT)
//   WARM = qualified, still in window (ACTIVE/WARM)
//   COOL = lower priority / follow-up
type Priority = "HOT" | "WARM" | "COOL";

const priorityOf = (tier: string | null | undefined, isUrgent?: boolean | null): Priority => {
  if (isUrgent) return "HOT";
  switch ((tier ?? "").toUpperCase()) {
    case "URGENT":
    case "CRITICAL":
    case "HOT":
      return "HOT";
    case "ACTIVE":
    case "WARM":
      return "WARM";
    default:
      return "COOL";
  }
};

const PRIORITY_META: Record<Priority, { label: string; classes: string; stripe: string }> = {
  HOT:  { label: "Hot",  classes: "bg-urgent text-urgent-foreground border-transparent", stripe: "bg-urgent" },
  WARM: { label: "Warm", classes: "bg-warm text-warm-foreground border-transparent",     stripe: "bg-warm" },
  COOL: { label: "Cool", classes: "bg-muted text-foreground/70 border-border",           stripe: "bg-muted" },
};

const PriorityBadge = ({ tier, isUrgent }: { tier: string | null | undefined; isUrgent?: boolean | null }) => {
  const meta = PRIORITY_META[priorityOf(tier, isUrgent)];
  return (
    <Badge className={cn("uppercase tracking-wider text-[10px]", meta.classes)}>
      {meta.label}
    </Badge>
  );
};

// Single source of truth for the row's "what's happening" tag.
// Collapses readiness + outreach status into ONE plain-English label so the
// pipeline reads at a glance instead of forcing users to decode multiple chips.
const StateChip = ({ label, tone, title, pulse }: { label: string; tone: string; title: string; pulse?: boolean }) => (
  <span
    title={title}
    className={cn(
      "inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-medium border rounded-sm",
      tone,
    )}
  >
    {pulse && <span className="inline-block h-1.5 w-1.5 rounded-full bg-current opacity-60 animate-pulse" />}
    {label}
  </span>
);

const LeadStatePill = ({ lead }: { lead: any }) => {
  const status = lead.status as string | null | undefined;
  const readiness = lead.readiness as string | null | undefined;
  const hasContact = Boolean(lead.contact_email || lead.contact_phone);

  const OUTREACH: Record<string, { label: string; tone: string; title: string }> = {
    contacted: { label: "Contacted",   tone: "bg-cold/15 text-cold border-cold/30", title: "Outreach sent — awaiting reply." },
    replied:   { label: "Replied",     tone: "bg-hot/15 text-hot border-hot/40",    title: "Seller replied — follow up." },
    meeting:   { label: "Meeting set", tone: "bg-hot/15 text-hot border-hot/40",    title: "Meeting on the calendar." },
    won:       { label: "Won",         tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30", title: "Closed / converted." },
  };
  if (status && OUTREACH[status]) {
    const m = OUTREACH[status];
    return <StateChip label={m.label} tone={m.tone} title={m.title} />;
  }
  if (readiness === "ready_for_outreach" || readiness === "contact_found" || hasContact) {
    return <StateChip label="Ready to call" tone="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30" title="Contact verified — reach out now." />;
  }
  if (readiness === "needs_manual_review" || readiness === "low_confidence") {
    return <StateChip label="Needs review" tone="bg-urgent/15 text-urgent border-urgent/40" title="Automated search exhausted — needs a human." />;
  }
  return <StateChip label="Finding contact…" tone="bg-muted text-muted-foreground border-border" title="Pipeline is still searching for the seller's contact info." pulse />;
};

export const OutreachDashboard = () => {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabKey>("candidates");
  const [tierFilter, setTierFilter] = useState<string>("all");
  const [stateFilter, setStateFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [readinessFilter, setReadinessFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const { data: leads, isLoading } = useQuery({
    queryKey: ["leads"],
    queryFn: async () => {
      // Only surface fresh leads — sales older than 60 days are past the 1031
      // identification window and not actionable. Pre-sale prospects (no sale_date)
      // are kept if they were discovered in the same window.
      const cutoffIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      const cutoffDate = cutoffIso.slice(0, 10);
      const { data, error } = await supabase
        .from("leads")
        .select("*")
        .neq("tier", "DISQUALIFIED")
        .or(`sale_date.gte.${cutoffDate},and(sale_date.is.null,created_at.gte.${cutoffIso})`)
        .order("is_urgent", { ascending: false })
        .order("created_at", { ascending: false })
        .order("score", { ascending: false })
        .limit(500);
      if (error) throw error;
      return data as Lead[];
    },
  });

  const { data: lastRun } = useQuery({
    queryKey: ["last-scan-job"],
    queryFn: async () => {
      const { data } = await supabase
        .from("pipeline_jobs")
        .select("created_at, finished_at, status, result")
        .eq("kind", "scan_sources")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data;
    },
  });

  // Portfolio-owner rollup — owners with ≥2 active properties.
  const { data: ownerRollup } = useQuery({
    queryKey: ["owner-rollup"],
    queryFn: async () => {
      const { data } = await supabase.from("lead_owner_rollup" as any).select("*");
      return ((data ?? []) as unknown) as OwnerRollup[];
    },
  });
  const ownerRollupMap = useMemo(() => {
    const m = new Map<string, OwnerRollup>();
    for (const r of ownerRollup ?? []) m.set(r.owner_key, r);
    return m;
  }, [ownerRollup]);
  const ownerKey = (name?: string | null) =>
    (name ?? "").toString().toUpperCase().replace(/[\s.,]+/g, " ").trim();

  useEffect(() => {
    const ch = supabase
      .channel("leads-feed")
      .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, () => {
        qc.invalidateQueries({ queryKey: ["leads"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "pipeline_jobs" }, () => {
        qc.invalidateQueries({ queryKey: ["last-scan-job"] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [qc]);

  const isPresale = (l: Lead) => l.pipeline_stage === "pre_sale_prospect";

  const isCandidate = (l: Lead) => {
    if (isPresale(l)) return false; // presale has its own tab
    if (l.tier === "COLD" || l.tier === "DISQUALIFIED" || l.tier === "UNSCORED") return false;
    if (l.readiness === "low_confidence" || l.readiness === "researching") return false;
    const trig = (l.trigger_event ?? "").toLowerCase();
    if (!trig.includes("sale") && trig !== "probate") return false;
    const otype = (l.owner_type ?? "").toLowerCase();
    return otype !== "individual" && otype !== "unknown" && otype !== "";
  };

  const filtered = useMemo(() => {
    if (!leads) return [];
    return leads.filter((l) => {
      if (tab === "candidates" && !isCandidate(l)) return false;
      if (tab === "presale" && !isPresale(l)) return false;
      if (tierFilter !== "all" && priorityOf(l.tier, l.is_urgent) !== tierFilter) return false;
      if (stateFilter !== "all" && l.state !== stateFilter) return false;
      if (statusFilter === "active" && (l.status === "dead" || l.status === "won")) return false;
      if (statusFilter !== "active" && statusFilter !== "all" && l.status !== statusFilter) return false;
      if (readinessFilter !== "all") {
        const r = l.readiness ?? "researching";
        const ready = r === "ready_for_outreach" || r === "contact_found";
        const review = r === "needs_manual_review" || r === "low_confidence";
        const researching = !ready && !review;
        if (readinessFilter === "ready" && !ready) return false;
        if (readinessFilter === "researching" && !researching) return false;
        if (readinessFilter === "review" && !review) return false;
      }
      if (search) {
        const s = search.toLowerCase();
        const blob = `${l.owner_name ?? ""} ${l.property_address ?? ""} ${l.property_city ?? ""}`.toLowerCase();
        if (!blob.includes(s)) return false;
      }
      return true;
    });
  }, [leads, tab, tierFilter, stateFilter, statusFilter, readinessFilter, search]);

  const ordered = useMemo(() => {
    return [...filtered].sort((a, b) => {
      // Newest sale date first — the most recent finds sit at the top
      const dateA = a.sale_date ? new Date(a.sale_date).getTime() : 0;
      const dateB = b.sale_date ? new Date(b.sale_date).getTime() : 0;
      return dateB - dateA;
    });
  }, [filtered]);

  const tabCounts = useMemo(() => {
    const c = { candidates: 0, presale: 0, active: 0 };
    for (const l of leads ?? []) {
      c.active += 1;
      if (isPresale(l)) c.presale += 1;
      else if (isCandidate(l)) c.candidates += 1;
    }
    return c;
  }, [leads]);

  const stats = useMemo(() => {
    if (!leads) return { total: 0, urgent: 0, hot: 0, tax: 0, ready: 0, in45: 0, in180: 0, presale: 0, portfolio: 0, avgDaysLeft: null as number | null };
    const urgent = leads.filter((l) => l.is_urgent).length;
    const hot = leads.filter((l) => l.tier === "HOT").length;
    const ready = leads.filter((l) => l.readiness === "ready_for_outreach" || l.readiness === "contact_found").length;
    const tax = leads.reduce((s, l) => s + (l.total_tax_exposure ?? 0), 0);
    let in45 = 0, in180 = 0, presale = 0, daysLeftSum = 0, daysLeftN = 0;
    for (const l of leads) {
      if (isPresale(l)) presale += 1;
      const w = windowStatus(l.sale_date);
      if (w) {
        if (w.daysLeft >= 0 && w.daysLeft <= 45) { in45 += 1; daysLeftSum += w.daysLeft; daysLeftN += 1; }
        else if (w.closeDaysLeft > 0) in180 += 1;
      }
    }
    const portfolio = new Set(
      (ownerRollup ?? []).filter((r) => r.property_count >= 2).map((r) => r.owner_key),
    ).size;
    return {
      total: leads.length, urgent, hot, tax, ready, in45, in180, presale, portfolio,
      avgDaysLeft: daysLeftN ? Math.round(daysLeftSum / daysLeftN) : null,
    };
  }, [leads, ownerRollup]);


  const activeFilterCount =
    (tierFilter !== "all" ? 1 : 0) +
    (stateFilter !== "all" ? 1 : 0) +
    (statusFilter !== "active" ? 1 : 0) +
    (readinessFilter !== "all" ? 1 : 0);

  const clearFilters = () => {
    setTierFilter("all");
    setStateFilter("all");
    setStatusFilter("active");
    setReadinessFilter("all");
  };

  const runScout = async () => {
    // Single entry point — run-scout edge function plans + enqueues jobs across
    // generic recorders, county adapters (Travis…), and external sources.
    setRunning(true);
    try {
      const { data, error } = await supabase.functions.invoke("run-scout", {
        body: { kinds: ["scan_sources", "scan_county", "scan_external"], force: true },
      });
      if (error) throw error;
      const planned = (data as any)?.inserted ?? 0;
      if (!planned) toast.info("Scout already running for every enabled county.");
      else toast.success(`Queued ${planned} scout jobs — processing now.`);
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["last-scan-job"] });
    } catch (e: any) {
      toast.error(`Couldn't start scout: ${e.message}`);
    } finally {
      setRunning(false);
    }
  };

  const exportCsv = () => {
    if (!filtered.length) {
      toast.error("Nothing to export with the current filters.");
      return;
    }
    const cols = [
      "tier", "score", "is_urgent", "state", "county", "property_address",
      "property_city", "owner_name", "owner_type", "sale_price", "sale_date",
      "capital_gains_estimate", "total_tax_exposure", "contact_email",
      "contact_phone", "status", "personality_type",
    ];
    const rows = [cols.join(",")];
    for (const l of filtered) {
      rows.push(cols.map((c) => JSON.stringify(l[c] ?? "")).join(","));
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `1031-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const states = useMemo(
    () => Array.from(new Set(leads?.map((l) => l.state) ?? [])).sort(),
    [leads],
  );

  const lastRefreshed = lastRun?.finished_at ?? lastRun?.created_at;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="p-6 md:p-8 space-y-8 max-w-[1600px] mx-auto">
        {/* Header */}
        <div className="relative overflow-hidden rounded-lg border bg-gradient-to-br from-primary via-primary to-primary/90 text-primary-foreground">
          <div className="absolute inset-0 opacity-[0.07] grid-lines pointer-events-none" />
          <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-accent/20 blur-3xl pointer-events-none" />
          <div className="relative p-6 md:p-8 flex items-start justify-between gap-6 flex-wrap">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/30 text-[10px] font-mono uppercase tracking-[0.15em]">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inset-0 rounded-full bg-accent animate-ping opacity-60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
                  </span>
                  Live
                </span>
                {lastRefreshed && (
                  <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-primary-foreground/60">
                    Last scan {fmtRelative(lastRefreshed)}
                  </span>
                )}
              </div>
              <div>
                <h1 className="font-display text-5xl md:text-6xl leading-[0.95] tracking-tight">
                  The Desk
                </h1>
                <p className="text-sm text-primary-foreground/70 mt-2 max-w-xl">
                  Intelligence on every fresh investment-property sale — surfaced, scored, and routed for the 180-day 1031 window.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={exportCsv}
                    disabled={!filtered.length}
                    className="bg-transparent border-primary-foreground/20 text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
                  >
                    <Download className="h-4 w-4" /> Export
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Download visible leads as CSV</TooltipContent>
              </Tooltip>

              {isAdmin && (
                <Button asChild variant="outline" size="sm" className="bg-transparent border-primary-foreground/20 text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground">
                  <Link to="/admin">
                    <Settings2 className="h-4 w-4" /> Sources
                  </Link>
                </Button>
              )}

              {isAdmin && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button onClick={runScout} disabled={running} size="sm" className="bg-accent text-accent-foreground hover:bg-accent/90">
                      {running ? (
                        <><Loader2 className="h-4 w-4 animate-spin" /> Scanning…</>
                      ) : (
                        <><Sparkles className="h-4 w-4" /> Find new leads</>
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Scans high-priority county records (CA, NY, NJ, FL, TX, OR, MA, IL, HI, NV…) for fresh investment property sales (1–2 min)
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        </div>

        {/* 1031 Pipeline Health strip — client-facing one-liner */}
        <div className="rounded-lg border bg-card p-4 md:p-5">
          <div className="flex items-center gap-2 mb-3">
            <Clock className="h-3.5 w-3.5 text-accent" />
            <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
              1031 Pipeline Health
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <HealthStat label="In 45-day window" value={stats.in45} tone={stats.in45 ? "accent" : "muted"} hint="Sellers still inside the 45-day identification window — the most actionable cohort." />
            <HealthStat label="In 46–180 day window" value={stats.in180} tone="muted" hint="Past identification but can still close a 1031 if a replacement is already identified." />
            <HealthStat label="Pre-sale prospects" value={stats.presale} tone={stats.presale ? "accent" : "muted"} hint="Listed but not yet sold — engage BEFORE the clock starts." />
            <HealthStat label="Portfolio owners" value={stats.portfolio} tone="muted" hint="Owners holding 2+ properties in your active pipeline — whale plays." />
            <HealthStat label="Avg days to deadline" value={stats.avgDaysLeft ?? "—"} tone={stats.avgDaysLeft != null && stats.avgDaysLeft <= 15 ? "warm" : "muted"} hint="Average 45-day identification clock remaining across the active cohort." />
          </div>
        </div>

        {/* KPI cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <KpiCard
            icon={<Briefcase className="h-4 w-4" />}
            label="Active leads"
            value={stats.total.toString()}
            hint="Worth-pursuing leads in your pipeline (cold and filtered-out leads excluded)."
          />
          <KpiCard
            icon={<AlertCircle className="h-4 w-4" />}
            label="Urgent"
            value={stats.urgent.toString()}
            accent={stats.urgent > 0}
            hint="Sold in the last 30 days — the 1031 clock is ticking."
          />
          <KpiCard
            icon={<Flame className="h-4 w-4" />}
            label="Hot leads"
            value={stats.hot.toString()}
            hint="Strongest 1031 candidates. Reach out first."
          />
          <KpiCard
            icon={<TrendingUp className="h-4 w-4" />}
            label="Pipeline tax exposure"
            value={fmtMoney(stats.tax, { compact: true })}
            hint="Combined estimated tax bill across all leads — how much a 1031 could defer."
          />
        </div>


        {/* Tabs + toolbar */}
        <Card className="overflow-hidden">
          <CardHeader className="space-y-4 pb-4 border-b bg-muted/20">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-1">
                  Lead Roster
                </div>
                <h2 className="font-display text-2xl leading-none">Full pipeline</h2>
              </div>
              <Tabs value={tab} onValueChange={(v) => { setTab(v as TabKey); setTierFilter("all"); }}>
                <TabsList>
                  <TabsTrigger value="candidates" className="gap-2">
                    1031 Candidates
                    <Badge variant="secondary" className="tabular">{tabCounts.candidates}</Badge>
                  </TabsTrigger>
                  <TabsTrigger value="presale" className="gap-2">
                    Pre-sale
                    <Badge variant="secondary" className="tabular">{tabCounts.presale}</Badge>
                  </TabsTrigger>
                  <TabsTrigger value="active" className="gap-2">
                    All active
                    <Badge variant="secondary" className="tabular">{tabCounts.active}</Badge>
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-[240px] max-w-md">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search owner, address, or city"
                  className="pl-9 h-9"
                />
                {search && (
                  <button
                    onClick={() => setSearch("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9">
                    <SlidersHorizontal className="h-4 w-4" />
                    Filters
                    {activeFilterCount > 0 && (
                      <Badge variant="secondary" className="ml-1 tabular">
                        {activeFilterCount}
                      </Badge>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-4 space-y-3">
                  <FilterSelect
                    value={tierFilter}
                    onChange={setTierFilter}
                    label="Priority"
                    options={[
                      { v: "all", l: "All priorities" },
                      { v: "HOT", l: "Hot — act this week" },
                      { v: "WARM", l: "Warm — qualified, in window" },
                      { v: "COOL", l: "Cool — follow up later" },
                    ]}
                  />
                  <FilterSelect
                    value={stateFilter}
                    onChange={setStateFilter}
                    label="State"
                    options={[
                      { v: "all", l: "All states" },
                      ...states.map((s) => ({ v: s, l: s })),
                    ]}
                  />
                  <FilterSelect
                    value={readinessFilter}
                    onChange={setReadinessFilter}
                    label="Readiness"
                    options={[
                      { v: "all", l: "All readiness" },
                      { v: "ready", l: "Ready — contact verified" },
                      { v: "researching", l: "Researching — finding contact" },
                      { v: "review", l: "Needs review" },
                    ]}
                  />
                  <FilterSelect
                    value={statusFilter}
                    onChange={setStatusFilter}
                    label="Workflow"
                    options={[
                      { v: "active", l: "Active (default)" },
                      { v: "all", l: "All statuses" },
                      { v: "new", l: "New" },
                      { v: "contacted", l: "Contacted" },
                      { v: "replied", l: "Replied" },
                      { v: "won", l: "Won" },
                      { v: "dead", l: "Dead" },
                    ]}
                  />
                  {activeFilterCount > 0 && (
                    <Button variant="ghost" size="sm" onClick={clearFilters} className="w-full">
                      Reset filters
                    </Button>
                  )}
                </PopoverContent>
              </Popover>

              <div className="ml-auto text-xs text-muted-foreground tabular">
                Showing {filtered.length} of {leads?.length ?? 0}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-muted-foreground mr-1">
                Quick view
              </span>
              {[
                { v: "all", l: "All" },
                { v: "ready", l: "Ready" },
                { v: "researching", l: "Researching" },
                { v: "review", l: "Needs review" },
              ].map((opt) => (
                <button
                  key={opt.v}
                  onClick={() => setReadinessFilter(opt.v)}
                  className={cn(
                    "px-2.5 py-1 rounded-full border text-[11px] font-medium transition-colors",
                    readinessFilter === opt.v
                      ? "bg-foreground text-background border-foreground"
                      : "bg-background text-muted-foreground border-border hover:border-foreground/40 hover:text-foreground",
                  )}
                >
                  {opt.l}
                </button>
              ))}
            </div>

            {activeFilterCount > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {tierFilter !== "all" && (
                  <FilterChip label={`Priority: ${tierFilter}`} onClear={() => setTierFilter("all")} />
                )}
                {stateFilter !== "all" && (
                  <FilterChip label={`State: ${stateFilter}`} onClear={() => setStateFilter("all")} />
                )}
                {statusFilter !== "active" && (
                  <FilterChip label={`Status: ${statusFilter}`} onClear={() => setStatusFilter("active")} />
                )}
                {readinessFilter !== "all" && (
                  <FilterChip label={`Readiness: ${readinessFilter.replace(/_/g, " ")}`} onClear={() => setReadinessFilter("all")} />
                )}
              </div>
            )}
          </CardHeader>

          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-6 space-y-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState
                onRun={isAdmin ? runScout : undefined}
                running={running}
                hasLeads={(leads?.length ?? 0) > 0}
                tab={tab}
              />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead>Priority</TableHead>
                      <TableHead>Property</TableHead>
                      <TableHead>Owner</TableHead>
                      
                       <TableHead className="text-right">Sale price</TableHead>
                      <TableHead className="text-right">Tax exposure</TableHead>
                      <TableHead>Sale date</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ordered.map((l) => (
                      <TableRow
                        key={l.id}
                        onClick={() => setSelectedId(l.id)}
                        className="cursor-pointer"
                      >
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <PriorityBadge tier={l.tier} isUrgent={l.is_urgent} />
                          </div>

                        </TableCell>
                        <TableCell>
                          <div className="text-sm font-medium">
                            {l.property_address ?? "Unknown address"}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {l.property_city}, {l.state} · {l.property_type}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm font-medium">{l.owner_name ?? "—"}</div>
                          <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
                            {l.owner_type ?? "Unknown"}
                          </div>
                          {(() => {
                            const r = ownerRollupMap.get(ownerKey(l.owner_name));
                            return r && r.property_count >= 2 ? (
                              <Badge variant="outline" className="mt-1 gap-1 text-[10px] font-normal border-accent/40 text-accent">
                                <Briefcase className="h-2.5 w-2.5" /> Portfolio · {r.property_count} props
                              </Badge>
                            ) : null;
                          })()}
                          <SellerIcons lead={l} />
                        </TableCell>
                        <TableCell className="text-right tabular font-mono text-sm">
                          {fmtMoney(l.sale_price, { compact: true })}
                        </TableCell>
                        <TableCell className="text-right tabular font-mono text-sm font-semibold text-accent">
                          {fmtMoney(l.total_tax_exposure, { compact: true })}
                        </TableCell>
                        <TableCell>
                          <div className="text-sm tabular">{fmtDate(l.sale_date)}</div>
                          <div className="text-[11px] text-muted-foreground">{fmtRelative(l.sale_date)}</div>
                        </TableCell>
                        <TableCell>
                          <LeadStatePill lead={l} />
                        </TableCell>

                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <RemoveLeadButton leadId={l.id} ownerName={l.owner_name} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {selectedId && <LeadDrawer leadId={selectedId} onClose={() => setSelectedId(null)} />}
      </div>
    </TooltipProvider>
  );
};

const KpiCard = ({
  label,
  value,
  accent,
  hint,
  icon,
}: {
  label: string;
  value: string;
  accent?: boolean;
  hint?: string;
  icon?: React.ReactNode;
}) => {
  const inner = (
    <Card className={cn("h-full transition-all hover:shadow-md hover:-translate-y-0.5 relative overflow-hidden group", accent && "border-accent/40")}>
      {accent && <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-accent to-transparent" />}
      <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-[10px] font-mono font-medium text-muted-foreground uppercase tracking-[0.15em]">
          {label}
        </CardTitle>
        {icon && (
          <span className={cn("h-7 w-7 inline-flex items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors group-hover:bg-accent/10 group-hover:text-accent", accent && "bg-accent/10 text-accent")}>
            {icon}
          </span>
        )}
      </CardHeader>
      <CardContent>
        <div className={cn("font-display text-4xl tabular leading-none", accent && "text-accent")}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
  if (!hint) return inner;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="cursor-help">{inner}</div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
};

const HealthStat = ({ label, value, tone, hint }: { label: string; value: number | string; tone: "accent" | "warm" | "muted"; hint?: string }) => {
  const valClass = tone === "accent" ? "text-accent" : tone === "warm" ? "text-warm" : "text-foreground";
  const inner = (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-[0.15em] text-muted-foreground">{label}</div>
      <div className={cn("font-display text-2xl tabular leading-none mt-1", valClass)}>{value}</div>
    </div>
  );
  if (!hint) return inner;
  return (
    <Tooltip>
      <TooltipTrigger asChild><div className="cursor-help">{inner}</div></TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">{hint}</TooltipContent>
    </Tooltip>
  );
};

const RemoveLeadButton = ({ leadId, ownerName }: { leadId: string; ownerName?: string | null }) => {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const label = ownerName ? ` "${ownerName}"` : "";
    if (!window.confirm(`Remove this lead${label} from the pipeline? It won't show up again.`)) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from("leads")
        .update({
          tier: "DISQUALIFIED",
          pipeline_stage: "disqualified",
          status: "dead",
          qualification_reason: "Manually removed by user",
        })
        .eq("id", leadId);
      if (error) throw error;
      toast.success("Lead removed from pipeline.");
      qc.invalidateQueries({ queryKey: ["leads"] });
    } catch (err: any) {
      toast.error(`Couldn't remove lead: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          disabled={busy}
          className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
          aria-label="Remove lead from pipeline"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        </button>
      </TooltipTrigger>
      <TooltipContent>Remove from pipeline</TooltipContent>
    </Tooltip>
  );
};

const FilterChip = ({ label, onClear }: { label: string; onClear: () => void }) => (
  <Badge variant="secondary" className="gap-1 pr-1">
    {label}
    <button
      onClick={onClear}
      className="ml-0.5 inline-flex items-center justify-center rounded-sm hover:bg-background/60 p-0.5"
      aria-label={`Clear ${label}`}
    >
      <X className="h-3 w-3" />
    </button>
  </Badge>
);

const WindowPill = ({ saleDate }: { saleDate?: string | null }) => {
  const w = windowStatus(saleDate);
  if (!w) return null;
  if (w.tone === "expired") return null; // hide once 45-day ID window has closed — not actionable
  const tone =
    w.tone === "fresh"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/20"
      : w.tone === "active"
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/20"
      : w.tone === "closing"
      ? "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/20"
      : "bg-muted text-muted-foreground border-transparent";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={cn("mt-1 gap-1 font-normal text-[10px]", tone)}>
          <Clock className="h-2.5 w-2.5" /> {w.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>Days left in the 45-day 1031 identification window.</TooltipContent>
    </Tooltip>
  );
};

const SellerIcons = ({ lead }: { lead: any }) => {
  const items: { icon: React.ReactNode; on: boolean; label: string; value?: string }[] = [
    { icon: <Mail className="h-3 w-3" />, on: !!lead.contact_email, label: "Email", value: lead.contact_email },
    { icon: <Phone className="h-3 w-3" />, on: !!lead.contact_phone, label: "Phone", value: lead.contact_phone },
    { icon: <Linkedin className="h-3 w-3" />, on: !!lead.contact_linkedin, label: "LinkedIn", value: lead.contact_linkedin },
    
  ];
  return (
    <div className="mt-1.5 flex items-center gap-1">
      {items.map((it, i) => (
        <Tooltip key={i}>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "inline-flex items-center justify-center h-5 w-5 rounded-sm",
                it.on ? "text-accent bg-accent/10" : "text-muted-foreground/30",
              )}
            >
              {it.icon}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {it.on && it.value ? `${it.label}: ${it.value}` : `${it.label} missing`}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
};

const FilterSelect = ({
  value,
  onChange,
  label,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  options: { v: string; l: string }[];
}) => (
  <div className="space-y-1.5">
    <span className="text-xs font-medium text-muted-foreground">{label}</span>
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-9 w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.v} value={o.v}>
            {o.l}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  </div>
);

const EmptyState = ({
  onRun,
  running,
  hasLeads,
  tab,
}: {
  onRun?: () => void;
  running: boolean;
  hasLeads: boolean;
  tab: TabKey;
}) => {
  if (!hasLeads) {
    return (
      <div className="p-16 text-center">
        <div className="font-display text-3xl mb-3">No leads yet.</div>
        <div className="text-sm text-muted-foreground max-w-md mx-auto mb-6 leading-relaxed">
          Click <span className="font-semibold text-foreground">Find new leads</span> to scan
          high-priority county records (CA, NY, NJ, FL, TX, OR, MA, IL, HI, NV…) for recent investment property sales. This usually takes 1–2 minutes.
        </div>
        {onRun && (
          <Button onClick={onRun} disabled={running}>
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Find new leads
          </Button>
        )}
      </div>
    );
  }
  const tabCopy: Record<TabKey, string> = {
    candidates: "No active 1031 candidates yet. Click 'Find new leads' or check the Pre-sale tab.",
    presale: "No pre-sale prospects yet — these are listed-but-not-yet-sold investment properties.",
    active: "No leads match your current filters. Try clearing them or switching tabs.",
  };
  return (
    <div className="p-16 text-center">
      <div className="font-display text-2xl mb-2">No matches.</div>
      <div className="text-sm text-muted-foreground max-w-md mx-auto">{tabCopy[tab]}</div>
    </div>
  );
};

