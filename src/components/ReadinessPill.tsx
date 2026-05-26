import { cn } from "@/lib/utils";

// Collapsed 3-state readiness. The DB has 6+ states (ready_for_outreach,
// contact_found, needs_contact_info, needs_manual_review, researching,
// low_confidence) — too noisy. We bucket them:
//   ready       = contact verified, can reach out now
//   researching = pipeline still hunting for contact
//   review      = automated search failed / weak fit, needs a human
type ReadinessBucket = "ready" | "researching" | "review";

const bucketOf = (readiness: string | null | undefined): ReadinessBucket => {
  switch (readiness) {
    case "ready_for_outreach":
    case "contact_found":
      return "ready";
    case "needs_manual_review":
    case "low_confidence":
      return "review";
    default:
      return "researching";
  }
};

export const READINESS_META: Record<ReadinessBucket, { label: string; tone: string; darkTone: string; description: string }> = {
  ready: {
    label: "Ready",
    tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
    darkTone: "bg-emerald-400/20 text-emerald-100 border-emerald-400/40",
    description: "Contact verified — reach out now.",
  },
  researching: {
    label: "Researching",
    tone: "bg-muted text-muted-foreground border-border",
    darkTone: "bg-white/15 text-white border-white/20",
    description: "Pipeline is still finding a contact.",
  },
  review: {
    label: "Review",
    tone: "bg-urgent/15 text-urgent border-urgent/40",
    darkTone: "bg-urgent/30 text-urgent border-urgent/50",
    description: "Automated search exhausted — needs a human.",
  },
};

export const ReadinessPill = ({ readiness, dark }: { readiness: string | null | undefined; dark?: boolean }) => {
  const meta = READINESS_META[bucketOf(readiness)];
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider border",
        dark ? meta.darkTone : meta.tone,
      )}
      title={meta.description}
    >
      {meta.label}
    </span>
  );
};
