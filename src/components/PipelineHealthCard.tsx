import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";

const STAGES = [
  { key: "raw_candidate", label: "Raw" },
  { key: "verified", label: "Verified" },
  { key: "qualified", label: "Qualified" },
  { key: "enriched", label: "Enriched" },
  { key: "ready", label: "Ready" },
  { key: "needs_review", label: "Needs review" },
  { key: "disqualified", label: "Disqualified" },
  { key: "expired", label: "Expired" },
] as const;

const JOB_KINDS = [
  "scan_sources", "verify_property", "qualify_lead", "enrich_contact", "draft_outreach",
] as const;

export const PipelineHealthCard = () => {
  const [sweeping, setSweeping] = useState(false);

  const { data: counts, refetch } = useQuery({
    queryKey: ["pipeline-stage-counts"],
    queryFn: async () => {
      const out: Record<string, number> = {};
      await Promise.all(
        STAGES.map(async (s) => {
          const { count } = await supabase
            .from("leads")
            .select("id", { count: "exact", head: true })
            .eq("pipeline_stage", s.key);
          out[s.key] = count ?? 0;
        }),
      );
      return out;
    },
    refetchInterval: 30_000,
  });

  const { data: jobCounts } = useQuery({
    queryKey: ["pipeline-job-counts"],
    queryFn: async () => {
      const out: Record<string, { queued: number; running: number; failed: number }> = {};
      await Promise.all(
        JOB_KINDS.map(async (k) => {
          const [q, r, f] = await Promise.all([
            supabase.from("pipeline_jobs").select("id", { count: "exact", head: true }).eq("kind", k).in("status", ["queued", "retry"]),
            supabase.from("pipeline_jobs").select("id", { count: "exact", head: true }).eq("kind", k).eq("status", "running"),
            supabase.from("pipeline_jobs").select("id", { count: "exact", head: true }).eq("kind", k).eq("status", "failed"),
          ]);
          out[k] = { queued: q.count ?? 0, running: r.count ?? 0, failed: f.count ?? 0 };
        }),
      );
      const stuckSince = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { count: stuck } = await supabase
        .from("pipeline_jobs")
        .select("id", { count: "exact", head: true })
        .eq("status", "running")
        .lt("locked_at", stuckSince);
      (out as any).__stuck = stuck ?? 0;
      return out;
    },
    refetchInterval: 15_000,
  });

  const max = Math.max(1, ...STAGES.map((s) => counts?.[s.key] ?? 0));

  const runSweeper = async () => {
    setSweeping(true);
    try {
      const { data, error } = await supabase.functions.invoke("pipeline-sweeper", { body: { trigger: "manual" } });
      if (error) throw error;
      toast.success(`Sweeper done · ${data?.requalified ?? 0} requalified · ${data?.re_enriched ?? 0} re-enriched · ${data?.re_drafted ?? 0} re-drafted · ${data?.expired ?? 0} expired`);
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sweeper failed");
    } finally {
      setSweeping(false);
    }
  };

  return (
    <section>
      <div className="flex items-end justify-between mb-3">
        <h2 className="kpi-label">Pipeline health</h2>
        <Button size="sm" variant="outline" onClick={runSweeper} disabled={sweeping}
          className="font-mono uppercase tracking-wider text-[10px]">
          {sweeping ? <Loader2 className="w-3 h-3 mr-2 animate-spin" /> : <Play className="w-3 h-3 mr-2" />}
          {sweeping ? "Sweeping…" : "Run sweeper"}
        </Button>
      </div>
      <div className="border border-border bg-card p-6 space-y-2">
        {STAGES.map((s) => {
          const v = counts?.[s.key] ?? 0;
          const pct = (v / max) * 100;
          return (
            <div key={s.key} className="grid grid-cols-[8rem_3rem_1fr] items-center gap-3">
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{s.label}</div>
              <div className="font-display text-lg tabular text-right">{v}</div>
              <div className="h-2 bg-secondary relative overflow-hidden">
                <div className={`h-full ${s.key === "ready" ? "bg-emerald-500" : s.key === "disqualified" || s.key === "expired" ? "bg-muted-foreground/40" : "bg-accent"}`}
                  style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6 border border-border bg-card p-6">
        <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mb-3">Job queue</div>
        <table className="w-full">
          <thead>
            <tr className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              <th className="text-left py-1">Kind</th>
              <th className="text-right py-1">Queued</th>
              <th className="text-right py-1">Running</th>
              <th className="text-right py-1">Failed</th>
            </tr>
          </thead>
          <tbody>
            {JOB_KINDS.map((k) => (
              <tr key={k} className="border-t border-border">
                <td className="py-2 font-mono text-xs">{k}</td>
                <td className="py-2 text-right tabular">{jobCounts?.[k]?.queued ?? 0}</td>
                <td className="py-2 text-right tabular">{jobCounts?.[k]?.running ?? 0}</td>
                <td className={`py-2 text-right tabular ${(jobCounts?.[k]?.failed ?? 0) > 0 ? "text-destructive" : ""}`}>{jobCounts?.[k]?.failed ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {((jobCounts as any)?.__stuck ?? 0) > 0 && (
          <div className="pt-3 mt-3 border-t border-border font-mono text-xs text-amber-600 dark:text-amber-400">
            ⚠ {(jobCounts as any).__stuck} job{(jobCounts as any).__stuck === 1 ? "" : "s"} running &gt; 10 minutes — sweeper will reset on next run
          </div>
        )}
      </div>
    </section>
  );
};
