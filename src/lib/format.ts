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
