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
} from "lucide-react";
import { toast } from "sonner";
import { LeadDrawer } from "./LeadDrawer";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

type Lead = any;
type TabKey = "candidates" | "active";

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

const tierBadgeClasses = (tier: string) => {
  switch (tier) {
    case "URGENT":
      return "bg-urgent text-urgent-foreground hover:bg-urgent/90 border-transparent";
    case "HOT":
      return "bg-hot text-hot-foreground hover:bg-hot/90 border-transparent";
    case "WARM":
      return "bg-warm text-warm-foreground hover:bg-warm/90 border-transparent";
    case "COLD":
      return "bg-cold text-cold-foreground hover:bg-cold/90 border-transparent";
    case "DISQUALIFIED":
      return "bg-disqualified text-disqualified-foreground border-transparent";
    default:
      return "bg-muted text-muted-foreground border-transparent";
  }
};

export const OutreachDashboard = () => {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabKey>("candidates");
  const [tierFilter, setTierFilter] = useState<string>("all");
  const [stateFilter, setStateFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const { data: leads, isLoading } = useQuery({
    queryKey: ["leads"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("leads")
        .select("*")
        .not("tier", "in", "(COLD,DISQUALIFIED)")
        .order("is_urgent", { ascending: false })
        .order("score", { ascending: false })
        .limit(500);
      if (error) throw error;
      return data as Lead[];
    },
  });

  const { data: lastRun } = useQuery({
    queryKey: ["last-scout-run"],
    queryFn: async () => {
      const { data } = await supabase
        .from("scout_runs")
        .select("finished_at, started_at, status")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data;
    },
  });

  useEffect(() => {
    const ch = supabase
      .channel("leads-feed")
      .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, () => {
        qc.invalidateQueries({ queryKey: ["leads"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "scout_runs" }, () => {
        qc.invalidateQueries({ queryKey: ["last-scout-run"] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [qc]);

  const isCandidate = (l: Lead) => {
    if (l.tier === "COLD" || l.tier === "DISQUALIFIED") return false;
    const trig = (l.trigger_event ?? "").toLowerCase();
    if (!trig.includes("sale") && trig !== "probate") return false;
    const otype = (l.owner_type ?? "").toLowerCase();
    return otype !== "individual" && otype !== "unknown" && otype !== "";
  };

  const filtered = useMemo(() => {
    if (!leads) return [];
    return leads.filter((l) => {
      if (tab === "candidates" && !isCandidate(l)) return false;
      if (tierFilter !== "all" && l.tier !== tierFilter) return false;
      if (stateFilter !== "all" && l.state !== stateFilter) return false;
      if (statusFilter === "active" && (l.status === "dead" || l.status === "won")) return false;
      if (statusFilter !== "active" && statusFilter !== "all" && l.status !== statusFilter) return false;
      if (search) {
        const s = search.toLowerCase();
        const blob = `${l.owner_name ?? ""} ${l.property_address ?? ""} ${l.property_city ?? ""}`.toLowerCase();
        if (!blob.includes(s)) return false;
      }
      return true;
    });
  }, [leads, tab, tierFilter, stateFilter, statusFilter, search]);

  const ordered = useMemo(() => {
    if (tab !== "candidates") return filtered;
    return [...filtered].sort((a, b) => {
      const da = a.sale_date ? new Date(a.sale_date).getTime() : 0;
      const db = b.sale_date ? new Date(b.sale_date).getTime() : 0;
      return db - da;
    });
  }, [filtered, tab]);

  const tabCounts = useMemo(() => {
    const c = { candidates: 0, active: 0 };
    for (const l of leads ?? []) {
      c.active += 1;
      if (isCandidate(l)) c.candidates += 1;
    }
    return c;
  }, [leads]);

  const stats = useMemo(() => {
    if (!leads) return { total: 0, urgent: 0, hot: 0, tax: 0 };
    const urgent = leads.filter((l) => l.is_urgent).length;
    const hot = leads.filter((l) => l.tier === "HOT").length;
    const tax = leads.reduce((s, l) => s + (l.total_tax_exposure ?? 0), 0);
    return { total: leads.length, urgent, hot, tax };
  }, [leads]);

  const activeFilterCount =
    (tierFilter !== "all" ? 1 : 0) +
    (stateFilter !== "all" ? 1 : 0) +
    (statusFilter !== "active" ? 1 : 0);

  const clearFilters = () => {
    setTierFilter("all");
    setStateFilter("all");
    setStatusFilter("active");
  };

  const runScout = async () => {
    setRunning(true);
    toast.loading("Scanning Nevada county records…", { id: "scout" });
    try {
      const { data, error } = await supabase.functions.invoke("scout-run", {
        body: { trigger_kind: "manual" },
      });
      if (error) throw error;
      const found = data?.leads_found ?? 0;
      const updated = data?.leads_updated ?? 0;
      toast.success(
        updated || found
          ? `Scan running — ${found} new, ${updated} refreshed so far. Pipeline updates automatically.`
          : `Scan started. New leads will appear here within 1–2 minutes.`,
        { id: "scout", duration: 6000 },
      );
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["last-scout-run"] });
    } catch (e: any) {
      toast.error(`Couldn't start scan: ${e.message}`, { id: "scout" });
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

  const lastRefreshed = lastRun?.finished_at ?? lastRun?.started_at;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="p-6 md:p-8 space-y-6 max-w-[1600px] mx-auto">
        {/* Header */}
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div className="space-y-1">
            <h1 className="font-display text-4xl md:text-5xl leading-none tracking-tight">
              The Desk
            </h1>
            <p className="text-sm text-muted-foreground">
              <span className="tabular font-medium text-foreground">{stats.total}</span> active leads
              {stats.urgent > 0 && (
                <> · <span className="text-urgent font-medium">{stats.urgent} urgent</span></>
              )}
              {lastRefreshed && <> · last scan {fmtRelative(lastRefreshed)}</>}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={exportCsv}
                  disabled={!filtered.length}
                >
                  <Download className="h-4 w-4" /> Export
                </Button>
              </TooltipTrigger>
              <TooltipContent>Download visible leads as CSV</TooltipContent>
            </Tooltip>

            {isAdmin && (
              <Button asChild variant="outline" size="sm">
                <Link to="/admin">
                  <Settings2 className="h-4 w-4" /> Sources
                </Link>
              </Button>
            )}

            {isAdmin && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button onClick={runScout} disabled={running} size="sm">
                    {running ? (
                      <><Loader2 className="h-4 w-4 animate-spin" /> Scanning…</>
                    ) : (
                      <><Plus className="h-4 w-4" /> Find new leads</>
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Scans Nevada county records for fresh investment property sales (1–2 min)
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {/* KPI cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <KpiCard
            label="Active leads"
            value={stats.total.toString()}
            hint="Worth-pursuing leads in your pipeline (cold and filtered-out leads excluded)."
          />
          <KpiCard
            label="Urgent"
            value={stats.urgent.toString()}
            accent={stats.urgent > 0}
            hint="Sold in the last 30 days — the 1031 clock is ticking."
          />
          <KpiCard
            label="Hot leads"
            value={stats.hot.toString()}
            hint="Strongest 1031 candidates. Reach out first."
          />
          <KpiCard
            label="Pipeline tax exposure"
            value={fmtMoney(stats.tax, { compact: true })}
            hint="Combined estimated tax bill across all leads — how much a 1031 could defer."
          />
        </div>

        {/* Tabs + toolbar */}
        <Card>
          <CardHeader className="space-y-4 pb-4">
            <Tabs value={tab} onValueChange={(v) => { setTab(v as TabKey); setTierFilter("all"); }}>
              <TabsList>
                <TabsTrigger value="candidates" className="gap-2">
                  1031 Candidates
                  <Badge variant="secondary" className="tabular">{tabCounts.candidates}</Badge>
                </TabsTrigger>
                <TabsTrigger value="active" className="gap-2">
                  All active
                  <Badge variant="secondary" className="tabular">{tabCounts.active}</Badge>
                </TabsTrigger>
              </TabsList>
            </Tabs>

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
                      <TableHead>Mailing</TableHead>
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
                          <SellerIcons lead={l} />
                        </TableCell>
                        <TableCell className="max-w-[220px]">
                          {l.mailing_address ? (
                            <div
                              className="text-xs text-muted-foreground leading-snug"
                              title={l.mailing_address}
                            >
                              {l.mailing_address}
                            </div>
                          ) : (
                            <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
                              no address
                            </Badge>
                          )}
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
                          <div className="flex items-center gap-1.5">
                            <span
                              className={cn(
                                "inline-block h-1.5 w-1.5 rounded-full",
                                STATUS_DOT[l.status] ?? "bg-muted-foreground/40",
                              )}
                            />
                            <span className="text-xs text-muted-foreground">
                              {STATUS_LABEL[l.status] ?? l.status}
                            </span>
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
}: {
  label: string;
  value: string;
  accent?: boolean;
  hint?: string;
}) => {
  const inner = (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className={cn("font-display text-3xl tabular leading-none", accent && "text-accent")}>
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
    { icon: <Home className="h-3 w-3" />, on: !!lead.mailing_address, label: "Mailing", value: lead.mailing_address },
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
          Click <span className="font-semibold text-foreground">Find new leads</span> to scan Nevada
          county records for recent investment property sales. This usually takes 1–2 minutes.
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
    candidates: "No active 1031 candidates yet. Click 'Find new leads' or check the All active tab.",
    active: "No leads match your current filters. Try clearing them or switching tabs.",
  };
  return (
    <div className="p-16 text-center">
      <div className="font-display text-2xl mb-2">No matches.</div>
      <div className="text-sm text-muted-foreground max-w-md mx-auto">{tabCopy[tab]}</div>
    </div>
  );
};
