import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";

const STAGES = [
  { key: "discovered", label: "Discovered" },
  { key: "scored", label: "Scored" },
  { key: "profiled", label: "Profiled" },
  { key: "enriched", label: "Enriched" },
  { key: "drafted", label: "Drafted" },
  { key: "ready", label: "Ready" },
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
      const { count: stuck } = await supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .neq("pipeline_stage", "ready")
        .lt("updated_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());
      out.__stuck = stuck ?? 0;
      return out;
    },
    refetchInterval: 30_000,
  });

  const max = Math.max(1, ...STAGES.map((s) => counts?.[s.key] ?? 0));

  const runSweeper = async () => {
    setSweeping(true);
    try {
      const { data, error } = await supabase.functions.invoke("pipeline-sweeper", {
        body: { trigger: "manual" },
      });
      if (error) throw error;
      toast.success(
        `Sweeper done · ${data?.rescored ?? 0} rescored · ${data?.reprofiled_for_contact ?? 0} re-enriched · ${data?.redrafted ?? 0} re-drafted`,
      );
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
        <Button
          size="sm"
          variant="outline"
          onClick={runSweeper}
          disabled={sweeping}
          className="font-mono uppercase tracking-wider text-[10px]"
        >
          {sweeping ? <Loader2 className="w-3 h-3 mr-2 animate-spin" /> : <Play className="w-3 h-3 mr-2" />}
          {sweeping ? "Sweeping…" : "Run sweeper"}
        </Button>
      </div>
      <div className="border border-border bg-card p-6 space-y-2">
        {STAGES.map((s) => {
          const v = counts?.[s.key] ?? 0;
          const pct = (v / max) * 100;
          return (
            <div key={s.key} className="grid grid-cols-[7rem_3rem_1fr] items-center gap-3">
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                {s.label}
              </div>
              <div className="font-display text-lg tabular text-right">{v}</div>
              <div className="h-2 bg-secondary relative overflow-hidden">
                <div
                  className={`h-full ${s.key === "ready" ? "bg-emerald-500" : "bg-accent"}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
        {(counts?.__stuck ?? 0) > 0 && (
          <div className="pt-3 mt-3 border-t border-border font-mono text-xs text-amber-600 dark:text-amber-400">
            ⚠ {counts?.__stuck} lead{counts?.__stuck === 1 ? "" : "s"} stuck &gt;24h without advancing
          </div>
        )}
      </div>
    </section>
  );
};
