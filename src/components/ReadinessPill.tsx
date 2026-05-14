import { cn } from "@/lib/utils";

export const READINESS_META: Record<string, { label: string; tone: string; darkTone: string; description: string }> = {
  ready_for_outreach: {
    label: "Ready for Outreach",
    tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
    darkTone: "bg-emerald-400/20 text-emerald-100 border-emerald-400/40",
    description: "Verified contact + brief — go.",
  },
  contact_found: {
    label: "Contact Found",
    tone: "bg-cold/20 text-cold border-cold/40",
    darkTone: "bg-cold/30 text-cold border-cold/50",
    description: "Email or phone identified.",
  },
  needs_contact_info: {
    label: "Needs Contact Info",
    tone: "bg-warm/20 text-warm border-warm/40",
    darkTone: "bg-warm/30 text-warm border-warm/50",
    description: "Owner known, hunting for email/phone.",
  },
  needs_manual_review: {
    label: "Needs Manual Review",
    tone: "bg-urgent/15 text-urgent border-urgent/40",
    darkTone: "bg-urgent/30 text-urgent border-urgent/50",
    description: "Automated search exhausted.",
  },
  researching: {
    label: "Researching",
    tone: "bg-muted text-muted-foreground border-border",
    darkTone: "bg-white/15 text-white border-white/20",
    description: "Pipeline still running.",
  },
  low_confidence: {
    label: "Low Confidence",
    tone: "bg-disqualified text-disqualified-foreground border-transparent",
    darkTone: "bg-white/10 text-white/70 border-transparent",
    description: "Weak 1031 fit.",
  },
};

export const ReadinessPill = ({ readiness, dark }: { readiness: string | null | undefined; dark?: boolean }) => {
  const meta = READINESS_META[readiness ?? "researching"] ?? READINESS_META.researching;
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider border",
        dark ? meta.darkTone : meta.tone,
      )}
    >
      {meta.label}
    </span>
  );
};
