import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Activity, AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { fmtRelative } from "@/lib/format";
import { toast } from "sonner";
import { useState } from "react";

const HOT_TIERS = ["URGENT", "CRITICAL", "ACTIVE", "HOT", "WARM"] as const;

export function PipelineHealthCard() {
  const [sweeping, setSweeping] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["pipeline-health"],
    refetchInterval: 30_000,
    queryFn: async () => {
      const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();

      const [jobs, stuckBriefs, stuckDiscovery] = await Promise.all([
        supabase
          .from("pipeline_jobs")
          .select("kind,status")
          .in("status", ["queued", "retry", "running", "failed"]),
        supabase
          .from("leads")
          .select("id, owner_name, property_city, state, tier, updated_at, pipeline_stage")
          .is("ai_brief", null)
          .in("tier", HOT_TIERS)
          .not("pipeline_stage", "in", "(discovered,scoring,disqualified,expired)")
          .lt("updated_at", cutoff)
          .order("updated_at", { ascending: true })
          .limit(10),
        supabase
          .from("leads")
          .select("id, owner_name, property_city, state, tier, updated_at")
          .eq("pipeline_stage", "needs_review")
          .in("tier", HOT_TIERS)
          .lt("updated_at", cutoff)
          .order("updated_at", { ascending: true })
          .limit(10),
      ]);

      const counts: Record<string, { queued: number; running: number; failed: number }> = {};
      for (const j of jobs.data ?? []) {
        const c = counts[j.kind] ??= { queued: 0, running: 0, failed: 0 };
        if (j.status === "queued" || j.status === "retry") c.queued++;
        else if (j.status === "running") c.running++;
        else if (j.status === "failed") c.failed++;
      }

      return {
        counts,
        stuckBriefs: stuckBriefs.data ?? [],
        stuckDiscovery: stuckDiscovery.data ?? [],
      };
    },
  });

  const runSweeper = async () => {
    setSweeping(true);
    try {
      const { data, error } = await supabase.functions.invoke("pipeline-sweeper", { body: {} });
      if (error) throw error;
      toast.success(`Sweeper ran · re-briefed ${data?.re_briefed ?? 0} · re-discovered ${data?.re_discovered ?? 0}`);
      await refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Sweeper failed");
    } finally {
      setSweeping(false);
    }
  };

  const stuckTotal = (data?.stuckBriefs.length ?? 0) + (data?.stuckDiscovery.length ?? 0);
  const totalFailed = Object.values(data?.counts ?? {}).reduce((s, c) => s + c.failed, 0);

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          Pipeline health
          {stuckTotal > 0 && (
            <Badge variant="destructive" className="tabular">{stuckTotal} stuck</Badge>
          )}
          {totalFailed > 0 && (
            <Badge variant="outline" className="tabular text-destructive border-destructive/40">
              {totalFailed} failed jobs
            </Badge>
          )}
        </CardTitle>
        <Button size="sm" variant="outline" onClick={runSweeper} disabled={sweeping}>
          {sweeping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Run sweeper
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              {(["scan_county", "qualify_lead", "enrich_contact", "seller_discovery", "lead_brief", "draft_outreach"] as const).map((k) => {
                const c = data?.counts[k] ?? { queued: 0, running: 0, failed: 0 };
                return (
                  <div key={k} className="rounded-md border bg-muted/30 px-2 py-1.5">
                    <div className="font-medium text-foreground">{k.replace(/_/g, " ")}</div>
                    <div className="text-muted-foreground tabular">
                      {c.running} running · {c.queued} queued
                      {c.failed > 0 && <span className="text-destructive"> · {c.failed} failed</span>}
                    </div>
                  </div>
                );
              })}
            </div>

            {stuckTotal > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium flex items-center gap-1.5 text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5" /> Leads stuck &gt; 30 min
                </div>
                <ul className="space-y-1 text-xs">
                  {data?.stuckBriefs.slice(0, 5).map((l: any) => (
                    <li key={`b-${l.id}`} className="flex items-center justify-between gap-2 rounded border px-2 py-1">
                      <span className="truncate">
                        <Badge variant="outline" className="mr-1.5 text-[10px]">brief</Badge>
                        {l.owner_name ?? "—"} · {l.property_city ?? "?"}, {l.state}
                      </span>
                      <span className="text-muted-foreground">{fmtRelative(l.updated_at)}</span>
                    </li>
                  ))}
                  {data?.stuckDiscovery.slice(0, 5).map((l: any) => (
                    <li key={`d-${l.id}`} className="flex items-center justify-between gap-2 rounded border px-2 py-1">
                      <span className="truncate">
                        <Badge variant="outline" className="mr-1.5 text-[10px]">discovery</Badge>
                        {l.owner_name ?? "—"} · {l.property_city ?? "?"}, {l.state}
                      </span>
                      <span className="text-muted-foreground">{fmtRelative(l.updated_at)}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-[11px] text-muted-foreground">
                  Click "Run sweeper" to re-enqueue these now, or wait for the next nightly sweep. <Link to="/admin" className="underline">Open Admin →</Link>
                </p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
