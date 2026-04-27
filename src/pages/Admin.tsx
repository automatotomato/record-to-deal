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
import { Loader2, Play, Sparkles, Target } from "lucide-react";
import { Progress } from "@/components/ui/progress";

const Admin = () => {
  const { isAdmin, loading } = useAuth();
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);
  const [qualifying, setQualifying] = useState(false);
  const [profiling, setProfiling] = useState(false);
  const [profileProgress, setProfileProgress] = useState({ done: 0, total: 0, ok: 0, fail: 0 });

  const runQualifier = async () => {
    setQualifying(true);
    try {
      const { data, error } = await supabase.functions.invoke("qualifier-run", {
        body: { rescore_all: true, auto_profile: true },
      });
      if (error) throw error;
      toast.success(`Scored ${data?.qualified ?? 0} leads · ${data?.tier_a ?? 0} tier A · ${data?.tier_b ?? 0} tier B · profiling top ${data?.auto_profiling ?? 0} in background`);
      qc.invalidateQueries({ queryKey: ["leads"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Qualifier failed");
    } finally {
      setQualifying(false);
    }
  };

  const profileAllUnprofiled = async () => {
    setProfiling(true);
    setProfileProgress({ done: 0, total: 0, ok: 0, fail: 0 });
    try {
      // Unprofiled = no contact_email AND no personality_type
      const { data: leads, error } = await supabase
        .from("leads")
        .select("id, property_address, owner_name")
        .is("contact_email", null)
        .is("personality_type", null)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      const list = leads ?? [];
      if (!list.length) {
        toast.info("No unprofiled leads found");
        return;
      }
      setProfileProgress({ done: 0, total: list.length, ok: 0, fail: 0 });
      toast.info(`Profiling ${list.length} leads — this may take a few minutes`);

      // Concurrency = 3 to avoid rate limits but keep things moving
      const queue = [...list];
      let ok = 0, fail = 0, done = 0;
      const worker = async () => {
        while (queue.length) {
          const lead = queue.shift();
          if (!lead) break;
          try {
            const { error: fnErr } = await supabase.functions.invoke("profiler-run", {
              body: { lead_id: lead.id },
            });
            if (fnErr) throw fnErr;
            ok += 1;
          } catch (e) {
            fail += 1;
            console.warn("Profiler failed for", lead.id, e);
          } finally {
            done += 1;
            setProfileProgress({ done, total: list.length, ok, fail });
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      toast.success(`Profiled ${ok} leads${fail ? ` · ${fail} failed` : ""}`);
      qc.invalidateQueries({ queryKey: ["leads"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Profile batch failed");
    } finally {
      setProfiling(false);
    }
  };

  const runScout = async () => {
    setRunning(true);
    try {
      const { data, error } = await supabase.functions.invoke("scout-run", {
        body: { trigger_kind: "manual" },
      });
      if (error) throw error;
      toast.success(`Scout complete — ${data?.leads_found ?? 0} new leads from ${data?.counties_scanned ?? 0} counties`);
      if (data?.errors?.length) {
        toast.warning(`${data.errors.length} county error(s) — see run log`);
      }
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["counties"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Scout failed");
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

  const { data: runs } = useQuery({
    queryKey: ["runs"],
    queryFn: async () => {
      const { data } = await supabase.from("scout_runs").select("*").order("started_at", { ascending: false }).limit(20);
      return data ?? [];
    },
  });

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
        <div className="flex items-center gap-3">
          <Button onClick={profileAllUnprofiled} disabled={profiling || running} variant="outline" size="lg" className="font-mono uppercase tracking-wider text-xs">
            {profiling ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
            {profiling ? `Profiling ${profileProgress.done}/${profileProgress.total}` : "Profile all unprofiled"}
          </Button>
          <Button onClick={runScout} disabled={running || profiling} size="lg" className="font-mono uppercase tracking-wider text-xs">
            {running ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
            {running ? "Scouting…" : "Run Scout now"}
          </Button>
        </div>
      </div>

      {profiling && profileProgress.total > 0 && (
        <div className="px-8 py-4 border-b border-border bg-secondary/30">
          <div className="flex items-center justify-between mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            <span>Profiling owners · {profileProgress.ok} ok · {profileProgress.fail} failed</span>
            <span className="tabular">{profileProgress.done} / {profileProgress.total}</span>
          </div>
          <Progress value={(profileProgress.done / profileProgress.total) * 100} className="h-1" />
        </div>
      )}


      <div className="p-8 space-y-10">
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
                      <Switch checked={c.enabled} onCheckedChange={(v) => toggle(c.id, v)} disabled={!["la_county", "cook_county"].includes(c.parser_key)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground italic">
            Only Los Angeles and Cook counties have parsers wired up. Others are placeholders for future expansion.
          </p>
        </section>

        <section>
          <h2 className="kpi-label mb-3">Recent scout runs</h2>
          <div className="border border-border bg-card">
            <table className="w-full">
              <thead className="border-b border-border bg-secondary/50">
                <tr className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                  <th className="text-left px-4 py-2">Started</th>
                  <th className="text-left px-4 py-2">Trigger</th>
                  <th className="text-left px-4 py-2">Status</th>
                  <th className="text-right px-4 py-2">Counties</th>
                  <th className="text-right px-4 py-2">Found</th>
                  <th className="text-right px-4 py-2">Qualified</th>
                  <th className="text-right px-4 py-2">Profiled</th>
                </tr>
              </thead>
              <tbody>
                {!runs?.length ? (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-xs text-muted-foreground italic">No runs yet</td></tr>
                ) : runs.map((r) => (
                  <tr key={r.id} className="border-b border-border">
                    <td className="px-4 py-2 font-mono text-xs">{fmtRelative(r.started_at)}</td>
                    <td className="px-4 py-2 font-mono text-xs uppercase">{r.trigger_kind}</td>
                    <td className="px-4 py-2 font-mono text-xs uppercase">{r.status}</td>
                    <td className="px-4 py-2 font-mono text-sm text-right tabular">{r.counties_scanned}</td>
                    <td className="px-4 py-2 font-mono text-sm text-right tabular">{r.leads_found}</td>
                    <td className="px-4 py-2 font-mono text-sm text-right tabular">{r.leads_qualified}</td>
                    <td className="px-4 py-2 font-mono text-sm text-right tabular">{r.leads_profiled}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </AppShell>
  );
};
export default Admin;
