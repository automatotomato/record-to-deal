import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtMoney, fmtRelative, tierColor, windowStatus } from "@/lib/format";
import { Loader2, Plus, Download, AlertCircle, Search, Mail, Phone, Linkedin, Home, Settings2, SlidersHorizontal, X, Clock } from "lucide-react";
import { toast } from "sonner";
import { LeadDrawer } from "./LeadDrawer";

import { useAuth } from "@/hooks/useAuth";

type Lead = any;
type TabKey = "candidates" | "active" | "cold" | "disqualified";

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

export const OutreachDashboard = () => {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabKey>("active");
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
        .order("is_urgent", { ascending: false })
        .order("score", { ascending: false })
        .limit(500);
      if (error) throw error;
      return data as Lead[];
    },
  });

  // Last successful scout run, for the "last refreshed" indicator
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

  // Realtime updates
  useEffect(() => {
    const ch = supabase.channel("leads-feed")
      .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, () => {
        qc.invalidateQueries({ queryKey: ["leads"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "scout_runs" }, () => {
        qc.invalidateQueries({ queryKey: ["last-scout-run"] });
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [qc]);

  const filtered = useMemo(() => {
    if (!leads) return [];
    return leads.filter((l) => {
      if (tab === "active" && (l.tier === "COLD" || l.tier === "DISQUALIFIED")) return false;
      if (tab === "cold" && l.tier !== "COLD") return false;
      if (tab === "disqualified" && l.tier !== "DISQUALIFIED") return false;
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

  const tabCounts = useMemo(() => {
    const c = { active: 0, cold: 0, disqualified: 0 };
    for (const l of leads ?? []) {
      if (l.tier === "COLD") c.cold += 1;
      else if (l.tier === "DISQUALIFIED") c.disqualified += 1;
      else c.active += 1;
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
      toast.success(
        `Scan started — ${data?.leads_found ?? 0} new leads found so far. Updates will appear automatically.`,
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
    const cols = ["tier", "score", "is_urgent", "state", "county", "property_address", "property_city", "owner_name", "owner_type", "sale_price", "sale_date", "capital_gains_estimate", "total_tax_exposure", "contact_email", "contact_phone", "status", "personality_type"];
    const rows = [cols.join(",")];
    for (const l of filtered) {
      rows.push(cols.map((c) => JSON.stringify(l[c] ?? "")).join(","));
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `1031-leads-${new Date().toISOString().slice(0, 10)}.csv`;
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
      <div className="min-h-screen">
        {/* Header */}
        <header className="border-b border-border px-8 pt-6 pb-5 bg-card">
          <div className="flex items-end justify-between gap-6 flex-wrap">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">
                1031 Outreach Pipeline
              </div>
              <h1 className="font-display text-5xl leading-none">The Desk.</h1>
              <p className="text-xs text-muted-foreground font-mono mt-2">
                <span className="tabular">{stats.total}</span> leads
                {stats.urgent > 0 && (
                  <> · <span className="text-urgent">{stats.urgent} urgent</span></>
                )}
                {lastRefreshed && (
                  <> · last scan {fmtRelative(lastRefreshed)}</>
                )}
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
                    className="rounded-none font-mono uppercase text-[10px] tracking-wider h-9"
                  >
                    <Download className="h-3 w-3 mr-1.5" /> Export CSV
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Download the visible leads as a spreadsheet</TooltipContent>
              </Tooltip>

              {isAdmin && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      asChild
                      variant="outline"
                      size="sm"
                      className="rounded-none font-mono uppercase text-[10px] tracking-wider h-9"
                    >
                      <Link to="/admin">
                        <Settings2 className="h-3 w-3 mr-1.5" /> Sources
                      </Link>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Manage the counties Scout monitors</TooltipContent>
                </Tooltip>
              )}

              {isAdmin && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      onClick={runScout}
                      disabled={running}
                      className="rounded-none bg-accent text-accent-foreground hover:bg-accent/90 font-mono uppercase text-[11px] tracking-wider h-9 px-4"
                    >
                      {running ? (
                        <><Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> Scanning…</>
                      ) : (
                        <><Plus className="h-3.5 w-3.5 mr-2" /> Find new leads</>
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

          {/* KPI strip — 4 client-facing metrics */}
          <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-px bg-border border border-border">
            <Kpi
              label="Total leads"
              value={stats.total.toString()}
              hint="Every property in your pipeline."
            />
            <Kpi
              label="Urgent"
              value={stats.urgent.toString()}
              accent={stats.urgent > 0}
              hint="Sold in the last 30 days — the 1031 clock is ticking."
            />
            <Kpi
              label="Hot leads"
              value={stats.hot.toString()}
              hint="Strongest 1031 candidates. Reach out first."
            />
            <Kpi
              label="Pipeline tax exposure"
              value={fmtMoney(stats.tax, { compact: true })}
              hint="Combined estimated tax bill across all leads — how much a 1031 could defer."
            />
          </div>
        </header>

        {/* Tabs */}
        <div className="px-8 border-b border-border bg-background flex items-center gap-0 overflow-x-auto">
          <TabButton
            active={tab === "active"}
            onClick={() => { setTab("active"); setTierFilter("all"); }}
            label="Worth pursuing"
            count={tabCounts.active}
            tooltip="Urgent, hot, warm, and unscored leads — your active pipeline."
          />
          <TabButton
            active={tab === "cold"}
            onClick={() => { setTab("cold"); setTierFilter("all"); }}
            label="Low priority"
            count={tabCounts.cold}
            tooltip="Cold leads — limited 1031 indicators. Worth a glance, not a call."
          />
          <TabButton
            active={tab === "disqualified"}
            onClick={() => { setTab("disqualified"); setTierFilter("all"); }}
            label="Filtered out"
            count={tabCounts.disqualified}
            tooltip="Owner-occupied homes, sales too small, or other non-investment profiles."
          />
        </div>

        {/* Search + filter bar */}
        <div className="px-8 py-3 border-b border-border bg-background flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[240px] max-w-lg">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by owner, address, or city"
              className="rounded-none pl-8 font-mono text-xs h-9"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="rounded-none font-mono uppercase text-[10px] tracking-wider h-9 relative"
              >
                <SlidersHorizontal className="h-3 w-3 mr-1.5" />
                Filters
                {activeFilterCount > 0 && (
                  <span className="ml-2 inline-flex items-center justify-center h-4 min-w-4 px-1 bg-accent text-accent-foreground text-[10px] tabular rounded-sm">
                    {activeFilterCount}
                  </span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 rounded-none p-4 space-y-3">
              <FilterSelect value={tierFilter} onChange={setTierFilter} label="Priority" options={[
                { v: "all", l: "All priorities" },
                { v: "URGENT", l: "Urgent" },
                { v: "HOT", l: "Hot" },
                { v: "WARM", l: "Warm" },
                { v: "COLD", l: "Cold" },
                { v: "UNSCORED", l: "Unscored" },
              ]} />
              <FilterSelect value={stateFilter} onChange={setStateFilter} label="State" options={[
                { v: "all", l: "All states" },
                ...states.map((s) => ({ v: s, l: s })),
              ]} />
              <FilterSelect value={statusFilter} onChange={setStatusFilter} label="Workflow" options={[
                { v: "active", l: "Active (default)" },
                { v: "all", l: "All statuses" },
                { v: "new", l: "New" },
                { v: "contacted", l: "Contacted" },
                { v: "replied", l: "Replied" },
                { v: "won", l: "Won" },
                { v: "dead", l: "Dead" },
              ]} />
              {activeFilterCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  className="w-full rounded-none font-mono uppercase text-[10px] tracking-wider"
                >
                  Reset filters
                </Button>
              )}
            </PopoverContent>
          </Popover>

          <div className="ml-auto font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Showing {filtered.length} of {leads?.length ?? 0}
          </div>
        </div>

        {/* Lead table */}
        <div className="overflow-auto">
          {isLoading ? (
            <div className="p-12 text-center text-xs font-mono uppercase tracking-widest text-muted-foreground">
              <Loader2 className="h-4 w-4 mx-auto mb-2 animate-spin" />Loading desk…
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              onRun={isAdmin ? runScout : undefined}
              running={running}
              hasLeads={(leads?.length ?? 0) > 0}
              tab={tab}
            />
          ) : (
            <table className="w-full">
              <thead className="bg-secondary/50 border-b border-border sticky top-0">
                <tr className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                  <Th>Priority</Th>
                  <Th>Property</Th>
                  <Th>Owner</Th>
                  <Th>Owner mailing</Th>
                  <Th right>Sale price</Th>
                  <Th right>Tax exposure</Th>
                  <Th>Last sale</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((l) => (
                  <tr
                    key={l.id}
                    onClick={() => setSelectedId(l.id)}
                    className="border-b border-border hover:bg-secondary/40 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {l.is_urgent && <AlertCircle className="h-3 w-3 text-urgent" />}
                        <span className={`tier-pill ${tierColor(l.tier)}`}>{l.tier}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-sm">{l.property_address ?? "Unknown address"}</div>
                      <div className="text-[11px] text-muted-foreground font-mono">
                        {l.property_city}, {l.state} · {l.property_type}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium">{l.owner_name ?? "—"}</div>
                      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mt-0.5">
                        {l.owner_type ?? "Unknown"}
                      </div>
                      <SellerIcons lead={l} />
                    </td>
                    <td className="px-4 py-3 max-w-[220px]">
                      {l.mailing_address ? (
                        <div
                          className="text-[11px] font-mono leading-snug text-muted-foreground"
                          title={l.mailing_address}
                        >
                          {l.mailing_address}
                        </div>
                      ) : (
                        <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60 px-1.5 py-0.5 bg-muted">
                          no address yet
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 data-cell text-right">
                      {fmtMoney(l.sale_price, { compact: true })}
                    </td>
                    <td className="px-4 py-3 data-cell text-right text-accent font-semibold">
                      {fmtMoney(l.total_tax_exposure, { compact: true })}
                    </td>
                    <td className="px-4 py-3 data-cell text-muted-foreground">
                      {fmtRelative(l.sale_date)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className={`inline-block h-1.5 w-1.5 rounded-full ${STATUS_DOT[l.status] ?? "bg-muted-foreground/40"}`} />
                        <span className="text-[11px] text-muted-foreground">
                          {STATUS_LABEL[l.status] ?? l.status}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {selectedId && <LeadDrawer leadId={selectedId} onClose={() => setSelectedId(null)} />}
      </div>
    </TooltipProvider>
  );
};

const Kpi = ({ label, value, accent, hint }: { label: string; value: string; accent?: boolean; hint?: string }) => {
  const inner = (
    <div className="bg-card p-4 h-full">
      <div className="kpi-label">{label}</div>
      <div className={`mt-1 font-display text-3xl tabular ${accent ? "text-accent" : ""}`}>{value}</div>
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

const TabButton = ({
  active, onClick, label, count, tooltip,
}: { active: boolean; onClick: () => void; label: string; count: number; tooltip: string }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        onClick={onClick}
        className={`px-4 py-3 font-mono text-[10px] uppercase tracking-[0.2em] border-b-2 -mb-px transition-colors whitespace-nowrap ${
          active
            ? "border-accent text-foreground"
            : "border-transparent text-muted-foreground hover:text-foreground"
        }`}
      >
        {label} <span className="ml-1 tabular text-muted-foreground">({count})</span>
      </button>
    </TooltipTrigger>
    <TooltipContent side="bottom" className="max-w-xs">{tooltip}</TooltipContent>
  </Tooltip>
);

const Th = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
  <th className={`px-4 py-2 font-medium ${right ? "text-right" : "text-left"}`}>{children}</th>
);

const SellerIcons = ({ lead }: { lead: any }) => {
  const items: { icon: React.ReactNode; on: boolean; label: string; value?: string }[] = [
    { icon: <Mail className="h-3 w-3" />, on: !!lead.contact_email, label: "Email", value: lead.contact_email },
    { icon: <Phone className="h-3 w-3" />, on: !!lead.contact_phone, label: "Phone", value: lead.contact_phone },
    { icon: <Linkedin className="h-3 w-3" />, on: !!lead.contact_linkedin, label: "LinkedIn", value: lead.contact_linkedin },
    { icon: <Home className="h-3 w-3" />, on: !!lead.mailing_address, label: "Mailing", value: lead.mailing_address },
  ];
  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      {items.map((it, i) => (
        <span
          key={i}
          title={it.on && it.value ? `${it.label}: ${it.value}` : `${it.label} missing`}
          className={`inline-flex items-center justify-center h-4 w-4 ${it.on ? "text-accent" : "text-muted-foreground/30"}`}
        >
          {it.icon}
        </span>
      ))}
    </div>
  );
};

const FilterSelect = ({
  value, onChange, label, options,
}: { value: string; onChange: (v: string) => void; label: string; options: { v: string; l: string }[] }) => (
  <div className="space-y-1">
    <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="rounded-none h-9 w-full font-mono text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.v} value={o.v} className="font-mono text-xs">{o.l}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  </div>
);

const EmptyState = ({
  onRun, running, hasLeads, tab,
}: { onRun?: () => void; running: boolean; hasLeads: boolean; tab: TabKey }) => {
  if (!hasLeads) {
    return (
      <div className="p-16 text-center">
        <div className="font-display text-4xl mb-3">No leads yet.</div>
        <div className="text-sm text-muted-foreground max-w-md mx-auto mb-6 leading-relaxed">
          Click <span className="font-semibold text-foreground">Find new leads</span> to scan Nevada
          county records for recent investment property sales. This usually takes 1–2 minutes.
        </div>
        {onRun && (
          <Button
            onClick={onRun}
            disabled={running}
            className="rounded-none bg-accent text-accent-foreground hover:bg-accent/90 font-mono uppercase text-xs tracking-wider h-10 px-5"
          >
            {running ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-2" />}
            Find new leads
          </Button>
        )}
      </div>
    );
  }
  const tabCopy: Record<TabKey, string> = {
    active: "No leads match your current filters. Try clearing them or switching tabs.",
    cold: "No cold leads right now — that's a good thing.",
    disqualified: "Nothing has been filtered out yet.",
  };
  return (
    <div className="p-16 text-center">
      <div className="font-display text-3xl mb-2">No matches.</div>
      <div className="text-sm text-muted-foreground max-w-md mx-auto">{tabCopy[tab]}</div>
    </div>
  );
};
