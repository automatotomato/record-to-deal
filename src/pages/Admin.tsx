import { useState, useEffect } from "react";
import { AppShell } from "@/components/AppShell";
import { useAuth } from "@/hooks/useAuth";
import { Navigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { fmtRelative } from "@/lib/format";
import { toast } from "sonner";
import { Loader2, Play } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { PipelineHealthCard } from "@/components/PipelineHealthCard";

const Admin = () => {
  const { isAdmin, loading } = useAuth();
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);

  const runScout = async () => {
    // Enqueue one scan_sources job per enabled county. Job priority is set from
    // state_tax_rates.priority_rank so high-tax states (CA, NY, NJ, OR…) and
    // federal-only targets (FL, TX) drain BEFORE everything else.
    setRunning(true);
    try {
      const [{ data: counties, error: cErr }, { data: rates }] = await Promise.all([
        supabase.from("counties").select("id, state").eq("enabled", true),
        supabase.from("state_tax_rates").select("state, priority_rank, is_target"),
      ]);
      if (cErr) throw cErr;
      const rankByState = new Map<string, number>();
      for (const r of rates ?? []) rankByState.set(r.state, r.priority_rank ?? 99);
      const rows = (counties ?? []).map((c) => ({
        kind: "scan_sources",
        county_id: c.id,
        priority: (rankByState.get(c.state) ?? 99) * 10,
      }));
      if (!rows.length) { toast.error("No enabled counties."); return; }
      const { error } = await supabase.from("pipeline_jobs").insert(rows);
      if (error) throw error;
      toast.success(`Queued ${rows.length} county scans — high-tax states first.`);
      qc.invalidateQueries({ queryKey: ["counties"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["pipeline-job-counts"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't queue scan");
    } finally {
      setRunning(false);
    }
  };

  const { data: counties } = useQuery({
    queryKey: ["counties"],
    queryFn: async () => {
      const { data } = await supabase.from("counties").select("*").order("state").order("county");
      return data ?? [];
    },
  });

  // Latest scout run, polled live so the user sees a progress bar while a scan is in flight.
  const { data: latestRun } = useQuery({
    queryKey: ["latest-scout-run"],
    queryFn: async () => {
      const { data } = await supabase
        .from("scout_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data;
    },
    refetchInterval: (q) => {
      const r = (q.state.data as any) ?? null;
      return r?.status === "running" ? 3000 : false;
    },
  });

  const enabledCount = (counties ?? []).filter((c: any) => c.enabled).length;

  const toggle = async (id: string, enabled: boolean) => {
    const { error } = await supabase.from("counties").update({ enabled }).eq("id", id);
    if (error) toast.error(error.message); else qc.invalidateQueries({ queryKey: ["counties"] });
  };

  if (loading) return null;
  if (!isAdmin) return <Navigate to="/outreach" replace />;

  return (
    <AppShell>
      <div className="px-8 py-6 border-b border-border bg-card flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">Configuration</div>
          <h1 className="font-display text-5xl leading-none">Sources.</h1>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Button onClick={runScout} disabled={running} size="lg" className="font-mono uppercase tracking-wider text-xs">
            {running ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
            {running ? "Queuing…" : "Run scan now"}
          </Button>
        </div>
      </div>


      <div className="p-8 space-y-10">
        <PipelineHealthCard />

        <section>
          <h2 className="kpi-label mb-3">Configured counties</h2>
          <div className="border border-border bg-card">
            <table className="w-full">
              <thead className="border-b border-border bg-secondary/50">
                <tr className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                  <th className="text-left px-4 py-2">State</th>
                  <th className="text-left px-4 py-2">County</th>
                  <th className="text-left px-4 py-2">Parser</th>
                  <th className="text-left px-4 py-2">Last run</th>
                  <th className="text-right px-4 py-2">Enabled</th>
                </tr>
              </thead>
              <tbody>
                {counties?.map((c) => (
                  <tr key={c.id} className="border-b border-border">
                    <td className="px-4 py-3 font-mono text-sm">{c.state}</td>
                    <td className="px-4 py-3 text-sm">{c.county}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{c.parser_key}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{fmtRelative(c.last_run_at)}</td>
                    <td className="px-4 py-3 text-right">
                      <Switch checked={c.enabled} onCheckedChange={(v) => toggle(c.id, v)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground italic">
            Toggle counties on/off to control which markets the scout scans on each run.
          </p>
        </section>

        <section>
          <h2 className="kpi-label mb-3">Scout status</h2>
          <ScoutRunStatus run={latestRun} totalCounties={enabledCount} />
        </section>
      </div>
    </AppShell>
  );
};

const ScoutRunStatus = ({ run, totalCounties }: { run: any; totalCounties: number }) => {
  if (!run) {
    return (
      <div className="border border-border bg-card p-6 text-sm text-muted-foreground italic">
        No scans have run yet. Click <span className="font-semibold text-foreground not-italic">Find new leads</span> to start one.
      </div>
    );
  }
  const isRunning = run.status === "running";
  const isFailed = run.status === "failed";
  const scanned = run.counties_scanned ?? 0;
  const denom = Math.max(totalCounties, scanned, 1);
  const pct = isRunning ? Math.min(95, Math.round((scanned / denom) * 100)) : 100;
  const found = run.leads_found ?? 0;
  const updated = run.leads_updated ?? 0;
  const elapsed = fmtRelative(run.started_at);
  const finishedLabel = run.finished_at ? fmtRelative(run.finished_at) : null;

  return (
    <div className="border border-border bg-card p-6 space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Loader2 className="h-4 w-4 animate-spin text-accent" />
          ) : isFailed ? (
            <span className="h-2 w-2 rounded-full bg-destructive" />
          ) : (
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
          )}
          <span className="font-mono text-[11px] uppercase tracking-widest">
            {isRunning ? "Scanning…" : isFailed ? "Last scan failed" : "Last scan complete"}
          </span>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {isRunning ? `started ${elapsed}` : finishedLabel ? `finished ${finishedLabel}` : `started ${elapsed}`}
        </span>
      </div>

      <Progress value={pct} className="h-1.5" />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-1">
        <Stat label="Counties scanned" value={`${scanned}${isRunning ? ` / ${totalCounties}` : ""}`} />
        <Stat label="New leads" value={found.toString()} accent={found > 0} />
        <Stat label="Refreshed leads" value={updated.toString()} />
        <Stat label="Errors" value={(run.errors?.length ?? 0).toString()} muted={!run.errors?.length} />
      </div>

      {isFailed && (
        <div className="text-xs text-destructive font-mono pt-2 border-t border-border">
          Scan didn't complete. Check function logs or try again.
        </div>
      )}
    </div>
  );
};

const Stat = ({ label, value, accent, muted }: { label: string; value: string; accent?: boolean; muted?: boolean }) => (
  <div>
    <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
    <div className={`font-display text-2xl tabular ${accent ? "text-accent" : muted ? "text-muted-foreground" : ""}`}>{value}</div>
  </div>
);

export default Admin;
