import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtMoney, fmtDate, fmtRelative, tierColor } from "@/lib/format";
import { Loader2, Play, Download, AlertCircle, Search, Mail, Phone, Linkedin, Home, MoreHorizontal } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { LeadDrawer } from "./LeadDrawer";
import { Progress } from "@/components/ui/progress";
import { useAuth } from "@/hooks/useAuth";

type Lead = any;

export const OutreachDashboard = () => {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
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

  // Realtime updates
  useEffect(() => {
    const ch = supabase.channel("leads-feed")
      .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, () => {
        qc.invalidateQueries({ queryKey: ["leads"] });
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [qc]);

  const filtered = useMemo(() => {
    if (!leads) return [];
    return leads.filter((l) => {
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
  }, [leads, tierFilter, stateFilter, statusFilter, search]);

  const stats = useMemo(() => {
    if (!leads) return { total: 0, urgent: 0, hot: 0, avgScore: 0, tax: 0, quality: 0 };
    const urgent = leads.filter((l) => l.is_urgent).length;
    const hot = leads.filter((l) => l.tier === "HOT").length;
    const scored = leads.filter((l) => l.score > 0);
    const avgScore = scored.length ? Math.round(scored.reduce((s, l) => s + l.score, 0) / scored.length) : 0;
    const tax = leads.reduce((s, l) => s + (l.total_tax_exposure ?? 0), 0);
    const qualifiable = leads.filter((l) => l.tier !== "DISQUALIFIED" && l.tier !== "UNSCORED");
    const complete = qualifiable.filter((l) => l.owner_name && l.mailing_address && l.total_tax_exposure);
    const quality = qualifiable.length ? Math.round((complete.length / qualifiable.length) * 100) : 0;
    return { total: leads.length, urgent, hot, avgScore, tax, quality };
  }, [leads]);

  const runScout = async () => {
    setRunning(true);
    toast.loading("Scout agent running…", { id: "scout" });
    try {
      const { data, error } = await supabase.functions.invoke("scout-run", {
        body: { trigger_kind: "manual" },
      });
      if (error) throw error;
      toast.success(`Scout finished: ${data?.leads_found ?? 0} new leads, ${data?.leads_qualified ?? 0} qualified`, { id: "scout" });
      qc.invalidateQueries({ queryKey: ["leads"] });
    } catch (e: any) {
      toast.error(`Scout failed: ${e.message}`, { id: "scout" });
    } finally {
      setRunning(false);
    }
  };

  const exportCsv = () => {
    if (!filtered.length) return;
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

  const states = useMemo(() => Array.from(new Set(leads?.map((l) => l.state) ?? [])).sort(), [leads]);

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-border px-8 py-6 bg-card">
        <div className="flex items-end justify-between">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">
              Outreach pipeline · Live feed
            </div>
            <h1 className="font-display text-5xl leading-none">The Desk.</h1>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <Button size="sm" onClick={runScout} disabled={running} className="rounded-none bg-accent text-accent-foreground hover:bg-accent/90 font-mono uppercase text-[10px] tracking-wider">
                {running ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Finding leads…</> : <><Play className="h-3 w-3 mr-1" /> Find new leads</>}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="rounded-none font-mono uppercase text-[10px] tracking-wider px-2">
                  <MoreHorizontal className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="rounded-none font-mono text-xs">
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">More</DropdownMenuLabel>
                <DropdownMenuItem onClick={exportCsv}>
                  <Download className="h-3 w-3 mr-2" /> Export CSV
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* KPI strip */}
        <div className="mt-8 grid grid-cols-6 gap-px bg-border border border-border">
          <Kpi label="Total leads" value={stats.total.toString()} />
          <Kpi label="Urgent (≤30d)" value={stats.urgent.toString()} accent={stats.urgent > 0} />
          <Kpi label="Hot tier" value={stats.hot.toString()} />
          <Kpi label="Avg score" value={stats.avgScore.toString()} />
          <Kpi label="Tax exposure" value={fmtMoney(stats.tax, { compact: true })} />
          <Kpi label="Data quality" value={`${stats.quality}%`} accent={stats.quality > 0 && stats.quality < 80} />
        </div>
      </header>

      {/* Filters */}
      <div className="px-8 py-4 border-b border-border bg-background flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search owner, address, city…" className="rounded-none pl-7 font-mono text-xs h-8" />
        </div>
        <FilterSelect value={tierFilter} onChange={setTierFilter} label="Tier" options={[
          { v: "all", l: "All tiers" },
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
        <FilterSelect value={statusFilter} onChange={setStatusFilter} label="Status" options={[
          { v: "active", l: "Active" },
          { v: "all", l: "All" },
          { v: "new", l: "New" },
          { v: "contacted", l: "Contacted" },
          { v: "replied", l: "Replied" },
          { v: "won", l: "Won" },
          { v: "dead", l: "Dead" },
        ]} />
        <div className="ml-auto font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {filtered.length} of {leads?.length ?? 0}
        </div>
      </div>

      {/* Lead table */}
      <div className="overflow-auto">
        {isLoading ? (
          <div className="p-12 text-center text-xs font-mono uppercase tracking-widest text-muted-foreground">
            <Loader2 className="h-4 w-4 mx-auto mb-2 animate-spin" />Loading desk…
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState onRun={isAdmin ? runScout : undefined} running={running} hasLeads={(leads?.length ?? 0) > 0} />
        ) : (
          <table className="w-full">
            <thead className="bg-secondary/50 border-b border-border sticky top-0">
              <tr className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                <Th>Tier</Th>
                <Th>Score</Th>
                <Th>Property</Th>
                <Th>Owner</Th>
                <Th>Type</Th>
                <Th>Mailing address</Th>
                <Th right>Sale price</Th>
                <Th right>Tax exposure</Th>
                <Th>Sold</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((l) => (
                <tr key={l.id} onClick={() => setSelectedId(l.id)}
                    className="border-b border-border hover:bg-secondary/40 cursor-pointer transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {l.is_urgent && <AlertCircle className="h-3 w-3 text-urgent" />}
                      <span className={`tier-pill ${tierColor(l.tier)}`}>{l.tier}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 data-cell font-semibold">{l.score || "—"}</td>
                  <td className="px-4 py-3">
                    <div className="text-sm">{l.property_address ?? "Unknown address"}</div>
                    <div className="text-[11px] text-muted-foreground font-mono">{l.property_city}, {l.state} · {l.property_type}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-sm font-medium">{l.owner_name ?? "—"}</div>
                    <SellerIcons lead={l} />
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 bg-secondary">
                      {l.owner_type ?? "—"}
                    </span>
                  </td>
                  <td className="px-4 py-3 max-w-[220px]">
                    {l.mailing_address ? (
                      <div className="text-[11px] font-mono leading-snug text-muted-foreground" title={l.mailing_address}>
                        {l.mailing_address}
                      </div>
                    ) : (
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/50">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 data-cell text-right">{fmtMoney(l.sale_price, { compact: true })}</td>
                  <td className="px-4 py-3 data-cell text-right text-accent font-semibold">{fmtMoney(l.total_tax_exposure, { compact: true })}</td>
                  <td className="px-4 py-3 data-cell text-muted-foreground">{fmtRelative(l.sale_date)}</td>
                  <td className="px-4 py-3">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{l.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selectedId && <LeadDrawer leadId={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
};

const Kpi = ({ label, value, accent }: { label: string; value: string; accent?: boolean }) => (
  <div className="bg-card p-4">
    <div className="kpi-label">{label}</div>
    <div className={`mt-1 font-display text-3xl tabular ${accent ? "text-accent" : ""}`}>{value}</div>
  </div>
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
  const hasAny = items.some((i) => i.on);
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
      {!hasAny && (
        <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60 ml-1">
          no contact yet
        </span>
      )}
    </div>
  );
};

const FilterSelect = ({ value, onChange, label, options }: { value: string; onChange: (v: string) => void; label: string; options: { v: string; l: string }[] }) => (
  <div className="flex items-center gap-2">
    <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="rounded-none h-8 w-[140px] font-mono text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => <SelectItem key={o.v} value={o.v} className="font-mono text-xs">{o.l}</SelectItem>)}
      </SelectContent>
    </Select>
  </div>
);

const EmptyState = ({ onRun, running, hasLeads }: { onRun?: () => void; running: boolean; hasLeads: boolean }) => (
  <div className="p-16 text-center">
    <div className="font-display text-3xl mb-2">{hasLeads ? "No matches." : "The desk is quiet."}</div>
    <div className="text-sm text-muted-foreground max-w-md mx-auto mb-6">
      {hasLeads
        ? "Adjust the filters above to see more leads."
        : "Run the Scout agent to scan public deed records in Los Angeles and Cook counties for fresh 1031 candidates."}
    </div>
    {onRun && !hasLeads && (
      <Button onClick={onRun} disabled={running} className="rounded-none bg-accent text-accent-foreground hover:bg-accent/90 font-mono uppercase text-xs tracking-wider">
        {running ? <Loader2 className="h-3 w-3 mr-2 animate-spin" /> : <Play className="h-3 w-3 mr-2" />}
        Run Scout now
      </Button>
    )}
  </div>
);
