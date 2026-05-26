export const fmtMoney = (n?: number | null, opts?: { compact?: boolean }) => {
  if (n == null) return "—";
  if (opts?.compact) {
    if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  }
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
};

export const fmtDate = (d?: string | null) => {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

export const fmtRelative = (d?: string | null) => {
  if (!d) return "—";
  const ms = Date.now() - new Date(d).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};

export const daysSince = (d?: string | null): number | null => {
  if (!d) return null;
  return Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
};

// 1031 exchange clock: 45 days to IDENTIFY replacement, 180 to close.
export type WindowStatus = {
  daysIn: number;
  daysLeft: number;       // days left to identify (45-day clock; negative once past)
  closeDaysLeft: number;  // days left to close (180-day clock)
  label: string;
  tone: "fresh" | "active" | "closing" | "expired" | "unknown";
};

export const windowStatus = (saleDate?: string | null): WindowStatus | null => {
  const d = daysSince(saleDate);
  if (d == null) return null;
  const idLeft = 45 - d;
  const closeLeft = 180 - d;
  if (d < 0) return { daysIn: 0, daysLeft: 45, closeDaysLeft: 180, label: "future sale", tone: "unknown" };
  if (d <= 15) return { daysIn: d, daysLeft: idLeft, closeDaysLeft: closeLeft, label: `Day ${d}/45 · ${idLeft}d to identify`, tone: "fresh" };
  if (d <= 35) return { daysIn: d, daysLeft: idLeft, closeDaysLeft: closeLeft, label: `Day ${d}/45 · ${idLeft}d to identify`, tone: "active" };
  if (d <= 45) return { daysIn: d, daysLeft: idLeft, closeDaysLeft: closeLeft, label: `Day ${d}/45 · ${idLeft}d — last call`, tone: "closing" };
  if (d <= 180) return { daysIn: d, daysLeft: 0, closeDaysLeft: closeLeft, label: `ID window closed · ${closeLeft}d to close`, tone: "closing" };
  return { daysIn: d, daysLeft: 0, closeDaysLeft: 0, label: "window closed", tone: "expired" };
};

export const tierColor = (tier: string) => {
  switch (tier) {
    case "URGENT": return "bg-urgent text-urgent-foreground";
    case "HOT": return "bg-hot text-hot-foreground";
    case "WARM": return "bg-warm text-warm-foreground";
    case "COLD": return "bg-cold text-cold-foreground";
    case "DISQUALIFIED": return "bg-disqualified text-disqualified-foreground";
    default: return "bg-muted text-muted-foreground";
  }
};
