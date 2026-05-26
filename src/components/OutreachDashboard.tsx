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
import { fmtMoney, fmtRelative, windowStatus } from "@/lib/format";
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
  Target,
  Briefcase,
  MapPin,
  ArrowUpRight,
  Activity,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { LeadDrawer } from "./LeadDrawer";

import { ReadinessPill } from "./ReadinessPill";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

type Lead = any;
type TabKey = "candidates" | "presale" | "active";
type OwnerRollup = { owner_key: string; property_count: number; total_sale_value: number; total_tax_exposure: number };

const STATUS_DOT: Record<string, string> = {
  new: "bg-accent",
  reviewing: "bg-warm",
  contacted: "bg-cold",
  replied: "bg-hot",
  meeting: "bg-hot",
  won: "bg-emerald-600",
  dead: "bg-muted-foreground/40",
};

const STATUS_LABEL: Record<string, string> = {
  new: "New",
  reviewing: "Reviewing",
  contacted: "Contacted",
  replied: "Replied",
  meeting: "Meeting",
  won: "Won",
  dead: "Dead",
};

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
      if (tierFilter !== "all" && l.tier !== tierFilter) return false;
      if (stateFilter !== "all" && l.state !== stateFilter) return false;
      if (statusFilter === "active" && (l.status === "dead" || l.status === "won")) return false;
      if (statusFilter !== "active" && statusFilter !== "all" && l.status !== statusFilter) return false;
      if (readinessFilter !== "all") {
        const r = l.readiness ?? "researching";
        if (readinessFilter === "ready_or_contact") {
          if (r !== "ready_for_outreach" && r !== "contact_found") return false;
        } else if (readinessFilter === "in_research") {
          if (r !== "researching" && r !== "needs_contact_info" && r !== "needs_manual_review") return false;
        } else if (r !== readinessFilter) return false;
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
    if (tab === "candidates") {
      // Sort by 1031 deadline ASCENDING (most urgent first), then tax exposure.
      return [...filtered].sort((a, b) => {
        const wa = windowStatus(a.sale_date);
        const wb = windowStatus(b.sale_date);
        const la = wa ? wa.daysLeft : 9999; // no sale date sinks
        const lb = wb ? wb.daysLeft : 9999;
        if (la !== lb) return la - lb;
        return (b.total_tax_exposure ?? 0) - (a.total_tax_exposure ?? 0);
      });
    }
    if (tab === "presale") {
      return [...filtered].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    }
    return filtered;
  }, [filtered, tab]);

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

  // Top "ready to go" leads — verified contact + strong fit, sorted by urgency then tax exposure.
  const readyLeads = useMemo(() => {
    if (!leads) return [];
    const ready = leads.filter(
      (l) =>
        isCandidate(l) &&
        (l.readiness === "ready_for_outreach" || l.readiness === "contact_found") &&
        (l.contact_email || l.contact_phone),
    );
    return ready
      .sort((a, b) => {
        if (a.is_urgent !== b.is_urgent) return a.is_urgent ? -1 : 1;
        const tierRank = { URGENT: 0, HOT: 1, WARM: 2, COLD: 3 } as Record<string, number>;
        const tr = (tierRank[a.tier] ?? 9) - (tierRank[b.tier] ?? 9);
        if (tr !== 0) return tr;
        return (b.total_tax_exposure ?? 0) - (a.total_tax_exposure ?? 0);
      })
      .slice(0, 3);
  }, [leads]);

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
    // Enqueue one scan_sources job per enabled county that is not already waiting/running.
    // Job priority is set from state_tax_rates.priority_rank so high-tax states
    // (CA, NY, NJ, OR…) drain BEFORE federal-only and lower-priority states.
    setRunning(true);
    try {
      const [{ data: counties, error: cErr }, { data: rates }, { data: activeJobs }] = await Promise.all([
        supabase.from("counties").select("id, state").eq("enabled", true),
        supabase.from("state_tax_rates").select("state, priority_rank, is_target"),
        supabase
          .from("pipeline_jobs")
          .select("county_id")
          .eq("kind", "scan_sources")
          .in("status", ["queued", "retry", "running"]),
      ]);
      if (cErr) throw cErr;
      const rankByState = new Map<string, number>();
      for (const r of rates ?? []) rankByState.set(r.state, r.priority_rank ?? 99);
      const activeCountyIds = new Set((activeJobs ?? []).map((j) => j.county_id).filter(Boolean));
      const rows = (counties ?? []).filter((c) => !activeCountyIds.has(c.id)).map((c) => ({
        kind: "scan_sources",
        county_id: c.id,
        priority: (rankByState.get(c.state) ?? 99) * 10,
      }));
      if (!rows.length) { toast.info("A scan is already queued or running for every enabled county."); return; }
      const { error } = await supabase.from("pipeline_jobs").insert(rows);
      if (error) throw error;
      supabase.functions.invoke("job-dispatcher", { body: { trigger: "manual" } });
      toast.success(`Queued ${rows.length} county scans — processing now.`);
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["last-scan-job"] });
    } catch (e: any) {
      toast.error(`Couldn't queue scan: ${e.message}`);
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

        {/* Priority Briefing — top ready-to-go leads */}
        {readyLeads.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-end justify-between gap-4 flex-wrap">
              <div>
                <div className="flex items-center gap-2">
                  <Target className="h-4 w-4 text-accent" />
                  <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
                    Priority Briefing
                  </span>
                </div>
                <h2 className="font-display text-2xl md:text-3xl mt-1 leading-tight">Ready to call today</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Verified contacts, strong 1031 fit, sorted by urgency and tax exposure.
                </p>
              </div>
              <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                {stats.ready} ready · {readyLeads.length} surfaced
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {readyLeads.map((l, i) => (
                <ReadyLeadCard key={l.id} lead={l} rank={i + 1} onOpen={() => setSelectedId(l.id)} />
              ))}
            </div>
          </section>
        )}

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
                      { v: "URGENT", l: "Urgent" },
                      { v: "HOT", l: "Hot" },
                      { v: "WARM", l: "Warm" },
                      { v: "UNSCORED", l: "Unscored" },
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
                      { v: "ready_or_contact", l: "Ready for outreach + Contact found" },
                      { v: "ready_for_outreach", l: "Ready for outreach only" },
                      { v: "contact_found", l: "Contact found only" },
                      { v: "in_research", l: "In research" },
                      { v: "needs_contact_info", l: "Needs contact info" },
                      { v: "needs_manual_review", l: "Needs manual review" },
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
                { v: "ready_or_contact", l: "Ready for outreach" },
                { v: "contact_found", l: "Contact found" },
                { v: "in_research", l: "In research" },
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
                      <TableHead>Last sale</TableHead>
                      <TableHead>Status</TableHead>
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
                            {l.is_urgent && <AlertCircle className="h-3.5 w-3.5 text-urgent shrink-0" />}
                            <Badge className={cn("uppercase tracking-wider text-[10px]", tierBadgeClasses(l.tier))}>
                              {l.tier}
                            </Badge>
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
                          <div className="text-xs text-muted-foreground">{fmtRelative(l.sale_date)}</div>
                          <WindowPill saleDate={l.sale_date} />
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <ReadinessPill readiness={l.readiness} />
                            <div className="flex items-center gap-1.5">
                              <span
                                className={cn(
                                  "inline-block h-1.5 w-1.5 rounded-full",
                                  STATUS_DOT[l.status] ?? "bg-muted-foreground/40",
                                )}
                              />
                              <span className="text-[11px] text-muted-foreground">
                                {STATUS_LABEL[l.status] ?? l.status}
                              </span>
                            </div>
                          </div>
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
  const tone =
    w.tone === "fresh"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/20"
      : w.tone === "active"
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/20"
      : w.tone === "closing"
      ? "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/20"
      : w.tone === "expired"
      ? "bg-muted text-muted-foreground/70 border-transparent"
      : "bg-muted text-muted-foreground border-transparent";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={cn("mt-1 gap-1 font-normal text-[10px]", tone)}>
          <Clock className="h-2.5 w-2.5" /> {w.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>1031 exchange clock: 180 days from sale to close on a replacement property.</TooltipContent>
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

const ReadyLeadCard = ({
  lead,
  rank,
  onOpen,
}: {
  lead: any;
  rank: number;
  onOpen: () => void;
}) => {
  const w = windowStatus(lead.sale_date);
  const urgency =
    w?.tone === "closing" || lead.is_urgent
      ? "border-urgent/50 hover:border-urgent"
      : w?.tone === "fresh"
      ? "border-emerald-500/40 hover:border-emerald-500"
      : "border-border hover:border-accent/50";
  return (
    <button
      onClick={onOpen}
      className={cn(
        "group relative text-left bg-card rounded-lg border-2 transition-all hover:shadow-lg hover:-translate-y-0.5 overflow-hidden",
        urgency,
      )}
    >
      {/* Rank ribbon */}
      <div className="absolute top-0 left-0 z-10 bg-primary text-primary-foreground font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded-br-md">
        #{rank}
      </div>

      {/* Tier accent strip */}
      <div className={cn("h-1 w-full", tierBadgeClasses(lead.tier).split(" ")[0])} />

      <div className="p-5 space-y-4">
        {/* Top row: tier + urgent flag */}
        <div className="flex items-start justify-between gap-2 pl-10">
          <div className="flex items-center gap-1.5">
            {lead.is_urgent && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-urgent text-urgent-foreground text-[9px] font-mono uppercase tracking-wider">
                <AlertCircle className="h-2.5 w-2.5" /> Urgent
              </span>
            )}
            <Badge className={cn("uppercase tracking-wider text-[10px]", tierBadgeClasses(lead.tier))}>
              {lead.tier}
            </Badge>
          </div>
          <ArrowUpRight className="h-4 w-4 text-muted-foreground group-hover:text-accent transition-colors" />
        </div>

        {/* Owner + property */}
        <div className="space-y-1">
          <div className="text-base font-semibold leading-tight">
            {lead.owner_name ?? "Unknown owner"}
          </div>
          <div className="text-xs text-muted-foreground uppercase tracking-wide">
            {lead.owner_type ?? "—"}
          </div>
          <div className="text-sm text-foreground/80 pt-1 flex items-start gap-1.5">
            <MapPin className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
            <span className="leading-snug">
              {lead.property_address ?? "Unknown address"}
              <span className="text-muted-foreground">
                {" · "}
                {lead.property_city}, {lead.state}
              </span>
            </span>
          </div>
        </div>

        {/* Money row */}
        <div className="grid grid-cols-2 gap-3 py-3 border-y border-border/60">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Sale price</div>
            <div className="font-display text-xl tabular leading-none mt-1">
              {fmtMoney(lead.sale_price, { compact: true })}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Tax exposure</div>
            <div className="font-display text-xl tabular leading-none mt-1 text-accent">
              {fmtMoney(lead.total_tax_exposure, { compact: true })}
            </div>
          </div>
        </div>

        {/* Footer: contact + window */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            {lead.contact_email && (
              <span className="inline-flex items-center justify-center h-6 w-6 rounded-sm bg-accent/10 text-accent" title={lead.contact_email}>
                <Mail className="h-3 w-3" />
              </span>
            )}
            {lead.contact_phone && (
              <span className="inline-flex items-center justify-center h-6 w-6 rounded-sm bg-accent/10 text-accent" title={lead.contact_phone}>
                <Phone className="h-3 w-3" />
              </span>
            )}
            {lead.contact_linkedin && (
              <span className="inline-flex items-center justify-center h-6 w-6 rounded-sm bg-accent/10 text-accent">
                <Linkedin className="h-3 w-3" />
              </span>
            )}
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground ml-1">
              Verified
            </span>
          </div>
          {w && (
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground flex items-center gap-1">
              <Clock className="h-2.5 w-2.5" /> {w.label}
            </div>
          )}
        </div>
      </div>
    </button>
  );
};
