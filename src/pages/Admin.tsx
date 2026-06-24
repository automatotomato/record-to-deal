import { useState } from "react";
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

const MANUAL_SCAN_LIMIT = 12;
const MANUAL_COUNTY_SCAN_LIMIT = 4;
// Commercial-only thesis: residential source removed. NV sellers skipped (no arbitrage to pitch).
const EXTERNAL_SOURCES = [["commercial", 0], ["court", 5], ["sec", 10]] as const;
const EXCLUDED_SCAN_STATES = new Set(["NV"]);

const Admin = () => {
  const { isAdmin, loading } = useAuth();
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);

  const runScout = async () => {
    setRunning(true);
    try {
      const [{ data: counties, error: cErr }, { data: rates }, { data: activeJobs }] = await Promise.all([
        supabase.from("counties").select("id, state, last_run_at").eq("enabled", true),
        supabase.from("state_tax_rates").select("state, priority_rank, is_target"),
        supabase
          .from("pipeline_jobs")
          .select("kind, county_id, payload")
          .in("kind", ["scan_sources", "scan_external"])
          .in("status", ["queued", "retry", "running"]),
      ]);
      if (cErr) throw cErr;
      const rankByState = new Map<string, number>();
      for (const r of rates ?? []) rankByState.set(r.state, r.priority_rank ?? 99);
      const activeCountyIds = new Set((activeJobs ?? []).filter((j: any) => j.kind === "scan_sources").map((j: any) => j.county_id).filter(Boolean));
      const activeExternal = new Set((activeJobs ?? []).filter((j: any) => j.kind === "scan_external").map((j: any) => `${j.payload?.state}:${j.payload?.source}`));
      const cutoff = Date.now() - 12 * 60 * 60 * 1000;
      const eligible = (counties ?? [])
        .filter((c) => !EXCLUDED_SCAN_STATES.has(c.state))
        .filter((c) => !activeCountyIds.has(c.id))
        .filter((c) => !c.last_run_at || new Date(c.last_run_at).getTime() < cutoff);
      const cooledDown = (counties ?? []).length - eligible.length - activeCountyIds.size;
      const countyRows: any[] = eligible.map((c) => ({
        kind: "scan_sources",
        county_id: c.id,
        priority: (rankByState.get(c.state) ?? 99) * 10,
        payload: {},
      }))
        .sort((a, b) => a.priority - b.priority)
        .slice(0, MANUAL_COUNTY_SCAN_LIMIT);
      const externalRows: any[] = [];
      for (const state of Array.from(new Set((counties ?? []).map((c) => c.state)))) {
        for (const [source, offset] of EXTERNAL_SOURCES) {
          if (!activeExternal.has(`${state}:${source}`)) externalRows.push({
            kind: "scan_external",
            payload: { state, source },
            priority: (rankByState.get(state) ?? 99) * 10 + offset,
          });
        }
      }
      const rows = [
        ...countyRows,
        ...externalRows.sort((a, b) => a.priority - b.priority).slice(0, MANUAL_SCAN_LIMIT - countyRows.length),
      ];
      if (!rows.length) {
        toast.info(cooledDown > 0
          ? `County records are in cooldown and external scans are already queued or running.`
          : `A scan is already queued or running for every enabled source.`);
        return;
      }
      const { error } = await supabase.from("pipeline_jobs").insert(rows);
      if (error) throw error;
      supabase.functions.invoke("job-dispatcher", { body: { trigger: "manual" } });
      const countiesQueued = rows.filter((r) => r.kind === "scan_sources").length;
      const externalQueued = rows.length - countiesQueued;
      toast.success(`Queued ${rows.length} scans (${countiesQueued} county, ${externalQueued} external) — processing now.`);
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

  const { data: scanStatus } = useQuery({
    queryKey: ["latest-scan-status"],
    queryFn: async () => {
      const { data: latest } = await supabase
        .from("pipeline_jobs")
        .select("created_at, finished_at, status, result")
        .eq("kind", "scan_sources")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data: active } = await supabase
        .from("pipeline_jobs")
        .select("status", { count: "exact" })
        .eq("kind", "scan_sources")
        .in("status", ["queued", "retry", "running"]);

      return { latest, activeCount: active?.length ?? 0 };
    },
    refetchInterval: (q) => ((q.state.data as any)?.activeCount > 0 ? 3000 : false),
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
      </div>

      <div className="p-8 space-y-10">
        <section>
          <div className="flex items-end justify-between gap-4 flex-wrap mb-3">
            <h2 className="kpi-label">Configured counties</h2>
            <Button onClick={runScout} disabled={running} size="sm" className="font-mono uppercase tracking-wider text-xs">
              {running ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
              {running ? "Queuing…" : "Run scan now"}
            </Button>
          </div>
          <div className="border border-border bg-card">
            <table className="w-full">
              <thead className="border-b border-border bg-secondary/50">
                <tr className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                  <th className="text-left px-4 py-2">State</th>
                  <th className="text-left px-4 py-2">County</th>
                  <th className="text-left px-4 py-2">Recorder source</th>
                  <th className="text-left px-4 py-2">Last run</th>
                  <th className="text-right px-4 py-2">Enabled</th>
                </tr>
              </thead>
              <tbody>
                {counties?.map((c) => {
                  const parked = !c.enabled && !c.recorder_index_url;
                  return (
                    <tr key={c.id} className="border-b border-border align-top">
                      <td className="px-4 py-3 font-mono text-sm">{c.state}</td>
                      <td className="px-4 py-3 text-sm">
                        {c.county}
                        {parked && (
                          <div className="font-mono text-[10px] uppercase tracking-wider text-urgent mt-0.5">
                            Parked — no free recorder source
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {c.recorder_index_url ? (
                          <a
                            href={c.recorder_index_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-accent hover:underline break-all"
                          >
                            {new URL(c.recorder_index_url).hostname}
                          </a>
                        ) : (
                          <span className="text-muted-foreground italic">none</span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{fmtRelative(c.last_run_at)}</td>
                      <td className="px-4 py-3 text-right">
                        <Switch checked={c.enabled} onCheckedChange={(v) => toggle(c.id, v)} disabled={parked} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground italic">
            Scout pulls from the county recorder's deed index first. Counties without a free public recorder URL are parked until one is wired in.
          </p>
        </section>

        <section>
          <h2 className="kpi-label mb-3">Scout status</h2>
          <ScoutRunStatus status={scanStatus} totalCounties={enabledCount} />
        </section>
      </div>
    </AppShell>
  );
};

const ScoutRunStatus = ({ status, totalCounties }: { status: any; totalCounties: number }) => {
  const run = status?.latest;
  if (!run) {
    return (
      <div className="border border-border bg-card p-6 text-sm text-muted-foreground italic">
        No scans have run yet. Click <span className="font-semibold text-foreground not-italic">Find new leads</span> to start one.
      </div>
    );
  }
  const activeCount = status?.activeCount ?? 0;
  const isRunning = activeCount > 0;
  const isFailed = run.status === "failed";
  const scanned = Math.max(0, totalCounties - activeCount);
  const denom = Math.max(totalCounties, scanned, 1);
  const pct = isRunning ? Math.min(95, Math.round((scanned / denom) * 100)) : 100;
  const found = run.result?.inserted ?? run.result?.found ?? 0;
  const updated = run.result?.enqueued ?? 0;
  const elapsed = fmtRelative(run.created_at);
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
        <Stat label="Queued follow-up" value={updated.toString()} />
        <Stat label="Errors" value={(run.result?.errors?.length ?? 0).toString()} muted={!run.result?.errors?.length} />
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
