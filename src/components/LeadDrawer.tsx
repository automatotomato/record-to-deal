import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtMoney, fmtDate, fmtRelative, tierColor, daysSince } from "@/lib/format";
import { Loader2, Sparkles, Send, AlertCircle, ExternalLink, Mail, Phone, Linkedin } from "lucide-react";
import { toast } from "sonner";

export const LeadDrawer = ({ leadId, onClose }: { leadId: string; onClose: () => void }) => {
  const qc = useQueryClient();
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [toEmail, setToEmail] = useState("");

  const { data: lead, isLoading } = useQuery({
    queryKey: ["lead", leadId],
    queryFn: async () => {
      const { data, error } = await supabase.from("leads").select("*").eq("id", leadId).single();
      if (error) throw error;
      return data as any;
    },
  });

  const { data: activities } = useQuery({
    queryKey: ["activities", leadId],
    queryFn: async () => {
      const { data } = await supabase.from("lead_activities").select("*").eq("lead_id", leadId).order("created_at", { ascending: false }).limit(50);
      return data ?? [];
    },
  });

  const { data: emails } = useQuery({
    queryKey: ["emails", leadId],
    queryFn: async () => {
      const { data } = await supabase.from("outreach_emails").select("*").eq("lead_id", leadId).order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  // Pre-fill email form from latest draft
  useEffect(() => {
    if (!lead) return;
    const latestDraft = emails?.find((e: any) => e.status === "draft");
    if (latestDraft) {
      setEmailSubject(latestDraft.subject);
      setEmailBody(latestDraft.body);
      setToEmail(latestDraft.to_email ?? lead.contact_email ?? "");
    } else {
      setToEmail(lead.contact_email ?? "");
    }
  }, [lead, emails]);

  const draftEmail = async (force = false) => {
    setDrafting(true);
    toast.loading(force ? "Re-profiling seller…" : "Profiling lead and drafting outreach…", { id: "draft" });
    try {
      const { data, error } = await supabase.functions.invoke("profiler-run", { body: { lead_id: leadId, force } });
      if (error) throw error;
      if ((data as any)?.cached) {
        toast.success("Using saved seller info", { id: "draft" });
      } else {
        toast.success("Draft ready", { id: "draft" });
      }
      qc.invalidateQueries({ queryKey: ["lead", leadId] });
      qc.invalidateQueries({ queryKey: ["emails", leadId] });
    } catch (e: any) {
      toast.error(`Draft failed: ${e.message}`, { id: "draft" });
    } finally {
      setDrafting(false);
    }
  };

  const sendEmail = async () => {
    if (!toEmail) { toast.error("No recipient email"); return; }
    if (!emailSubject || !emailBody) { toast.error("Subject and body required"); return; }
    setSending(true);
    toast.loading("Sending via Gmail…", { id: "send" });
    try {
      const { data, error } = await supabase.functions.invoke("send-outreach-email", {
        body: { lead_id: leadId, to: toEmail, subject: emailSubject, body: emailBody },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      toast.success("Sent!", { id: "send" });
      qc.invalidateQueries({ queryKey: ["lead", leadId] });
      qc.invalidateQueries({ queryKey: ["emails", leadId] });
      qc.invalidateQueries({ queryKey: ["activities", leadId] });
      qc.invalidateQueries({ queryKey: ["leads"] });
    } catch (e: any) {
      toast.error(`Send failed: ${e.message}`, { id: "send" });
    } finally {
      setSending(false);
    }
  };

  const updateStatus = async (status: string) => {
    await supabase.from("leads").update({ status: status as any }).eq("id", leadId);
    await supabase.from("lead_activities").insert({ lead_id: leadId, kind: "status_change", summary: `Status → ${status}` });
    qc.invalidateQueries({ queryKey: ["lead", leadId] });
    qc.invalidateQueries({ queryKey: ["leads"] });
    qc.invalidateQueries({ queryKey: ["activities", leadId] });
  };

  return (
    <Sheet open onOpenChange={onClose}>
      <SheetContent side="right" className="w-full sm:max-w-2xl p-0 overflow-y-auto bg-background border-l-2 border-border">
        {isLoading || !lead ? (
          <div className="p-12 text-center"><Loader2 className="h-4 w-4 mx-auto animate-spin" /></div>
        ) : (
          <div>
            {/* Header */}
            <div className="bg-primary text-primary-foreground p-6" style={{ background: lead.is_urgent ? "var(--gradient-urgent)" : "var(--gradient-ink)" }}>
              <div className="flex items-center gap-2 mb-2">
                {lead.is_urgent && (
                  <span className="tier-pill bg-card text-urgent flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" /> URGENT · {daysSince(lead.sale_date)}d ago
                  </span>
                )}
                <span className={`tier-pill ${tierColor(lead.tier)}`}>{lead.tier}</span>
                <span className="font-mono text-[10px] uppercase tracking-wider text-primary-foreground/60">
                  Score {lead.score} · {lead.state}
                </span>
              </div>
              <h2 className="font-display text-3xl leading-tight">{lead.property_address ?? "Unknown property"}</h2>
              <p className="font-mono text-xs uppercase tracking-wider text-primary-foreground/70 mt-1">
                {lead.property_city}, {lead.state} {lead.property_zip} · {lead.county} County
              </p>
            </div>

            {/* Quick facts */}
            <div className="grid grid-cols-3 gap-px bg-border border-b border-border">
              <Fact label="Sale price" value={fmtMoney(lead.sale_price, { compact: true })} />
              <Fact label="Tax exposure" value={fmtMoney(lead.total_tax_exposure, { compact: true })} accent />
              <Fact label="Sold" value={fmtRelative(lead.sale_date)} sub={fmtDate(lead.sale_date)} />
              <Fact label="Type" value={lead.property_type} />
              <Fact label="Owner type" value={lead.owner_type} />
              <Fact label="Held" value={lead.ownership_years ? `${lead.ownership_years}y` : "—"} />
            </div>

            {/* Seller / Owner */}
            <Section title="Seller information">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold">{lead.owner_name ?? "Unknown owner"}</div>
                  <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5">
                    {lead.owner_type ?? "Unknown"}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => draftEmail(false)}
                  disabled={drafting}
                  className="rounded-none font-mono text-[10px] uppercase tracking-wider shrink-0"
                >
                  {drafting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Sparkles className="h-3 w-3 mr-1" />}
                  {lead.contact_email || lead.contact_phone || lead.mailing_address ? "Re-profile" : "Find seller info"}
                </Button>
              </div>

              {lead.mailing_address && (
                <div className="mt-3 p-3 bg-secondary/50 border-l-2 border-accent">
                  <div className="kpi-label flex items-center gap-2">
                    Mailing address
                    {mailingFromAssessor(activities) && (
                      <span className="font-mono text-[9px] uppercase tracking-wider bg-accent text-accent-foreground px-1.5 py-0.5">
                        from county records
                      </span>
                    )}
                  </div>
                  <div className="text-sm font-mono mt-1 leading-relaxed">{lead.mailing_address}</div>
                </div>
              )}

              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <ContactPill icon={<Mail className="h-3 w-3" />} value={lead.contact_email} />
                <ContactPill icon={<Phone className="h-3 w-3" />} value={lead.contact_phone} />
                <ContactPill icon={<Linkedin className="h-3 w-3" />} value={lead.contact_linkedin} link />
              </div>

              {/* Completeness bar */}
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="kpi-label">Contact completeness</span>
                  <span className="font-mono text-[10px] tabular">{lead.contact_completeness ?? 0}%</span>
                </div>
                <div className="h-1 bg-muted overflow-hidden">
                  <div
                    className="h-full bg-accent transition-all"
                    style={{ width: `${Math.min(100, lead.contact_completeness ?? 0)}%` }}
                  />
                </div>
              </div>

              {!lead.contact_email && !lead.contact_phone && !lead.mailing_address && (
                <div className="mt-3 text-[11px] text-warm font-mono uppercase tracking-wider">
                  ⚠ No seller contact yet — click "Find seller info" to pull from public records
                </div>
              )}
            </Section>

            {/* Score breakdown */}
            {lead.score_breakdown && (
              <Section title="Score breakdown">
                <div className="space-y-1">
                  {Object.entries(lead.score_breakdown as Record<string, number>).map(([k, v]) => (
                    <div key={k} className="flex justify-between font-mono text-xs">
                      <span className="text-muted-foreground uppercase tracking-wider">{k.replace(/_/g, " ")}</span>
                      <span className="tabular font-semibold">+{v}</span>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Profile */}
            {lead.personality_type && (
              <Section title="Profile">
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div><div className="kpi-label">Personality</div><div className="mt-1">{lead.personality_type}</div></div>
                  <div><div className="kpi-label">Motivation</div><div className="mt-1">{lead.motivation_type}</div></div>
                  <div><div className="kpi-label">Best channel</div><div className="mt-1">{lead.preferred_channel}</div></div>
                  <div><div className="kpi-label">LV recommendation</div><div className="mt-1">{lead.lv_property_recommendation}</div></div>
                </div>
                {lead.profiler_summary && <p className="mt-3 text-xs text-muted-foreground italic leading-relaxed">{lead.profiler_summary}</p>}
              </Section>
            )}

            {/* Wealth signals */}
            {Array.isArray(lead.wealth_signals) && lead.wealth_signals.length > 0 && (
              <Section title="Wealth signals">
                <ul className="space-y-1 text-xs">
                  {lead.wealth_signals.map((s: any, i: number) => (
                    <li key={i} className="flex gap-2"><span className="text-accent">●</span><span>{typeof s === "string" ? s : s.signal}</span></li>
                  ))}
                </ul>
              </Section>
            )}

            {/* Outreach composer */}
            <Section title="Outreach">
              <div className="flex items-center gap-2 mb-3">
                <Button size="sm" variant="outline" onClick={draftEmail} disabled={drafting} className="rounded-none font-mono text-[10px] uppercase tracking-wider">
                  {drafting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Sparkles className="h-3 w-3 mr-1" />}
                  {lead.personality_type ? "Re-draft with AI" : "Profile + draft email"}
                </Button>
              </div>

              <div className="space-y-2">
                <Input value={toEmail} onChange={(e) => setToEmail(e.target.value)} placeholder="recipient@example.com"
                       className="rounded-none font-mono text-xs h-8" />
                <Input value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} placeholder="Subject"
                       className="rounded-none text-sm h-9" />
                <Textarea value={emailBody} onChange={(e) => setEmailBody(e.target.value)} rows={12}
                          placeholder="Email body — click 'Profile + draft email' to auto-generate."
                          className="rounded-none text-sm font-sans leading-relaxed" />
                <div className="flex justify-end">
                  <Button onClick={sendEmail} disabled={sending || !toEmail || !emailBody} className="rounded-none bg-accent text-accent-foreground hover:bg-accent/90 font-mono text-[10px] uppercase tracking-wider">
                    {sending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
                    Send via Gmail
                  </Button>
                </div>
              </div>
            </Section>

            {/* Status */}
            <Section title="Workflow">
              <div className="flex items-center gap-2">
                <span className="kpi-label">Status</span>
                <Select value={lead.status} onValueChange={updateStatus}>
                  <SelectTrigger className="rounded-none h-8 w-[180px] font-mono text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["new", "reviewing", "contacted", "replied", "meeting", "won", "dead"].map((s) =>
                      <SelectItem key={s} value={s} className="font-mono text-xs">{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </Section>

            {/* Reference links — public-record sources used to find seller info */}
            <ReferenceLinks lead={lead} activities={activities} />

            {/* Activity */}
            <Section title="Activity">
              {!activities?.length ? <div className="text-xs text-muted-foreground italic">No activity yet.</div> : (
                <ul className="space-y-2">
                  {activities.map((a: any) => (
                    <li key={a.id} className="text-xs flex gap-3 border-l-2 border-border pl-3 py-0.5">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground w-20 shrink-0">{a.kind}</span>
                      <span className="flex-1">{a.summary}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{fmtRelative(a.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            {lead.source_record_url && (
              <div className="px-6 py-4 border-t border-border">
                <a href={lead.source_record_url} target="_blank" rel="noopener" className="text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-accent inline-flex items-center gap-1">
                  <ExternalLink className="h-3 w-3" /> View source record
                </a>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
};

// Returns true if the most recent profiler_run activity recorded that the
// mailing address came from the official county assessor record.
function mailingFromAssessor(activities: any[] | undefined): boolean {
  if (!activities) return false;
  const latest = activities.find((a) => a.kind === "profiler_run");
  return !!latest?.payload?.mailing_from_assessor;
}

// Aggregate every public-record / web URL the Profiler used so the user
// can verify where the seller info came from.
const ReferenceLinks = ({ lead, activities }: { lead: any; activities: any[] | undefined }) => {
  const profilerRuns = (activities ?? []).filter((a) => a.kind === "profiler_run");
  const sourceUrls: string[] = [];
  for (const run of profilerRuns) {
    const s = run?.payload?.sources;
    if (Array.isArray(s)) sourceUrls.push(...s.filter((u: any) => typeof u === "string" && u.startsWith("http")));
  }
  const uniqueSources = Array.from(new Set(sourceUrls)).slice(0, 12);

  // Always-available manual lookup links so the user can dig deeper
  const manualLinks: { label: string; url: string }[] = [];
  const state = (lead.state ?? "").toUpperCase();
  const county = (lead.county ?? "").toLowerCase();
  const parcel = (lead.parcel_number ?? "").replace(/[^0-9]/g, "");
  const addr = encodeURIComponent(lead.property_address ?? "");
  const ownerQ = encodeURIComponent(lead.owner_name ?? "");

  if (state === "CA" && county.includes("los angeles")) {
    if (parcel.length >= 8) manualLinks.push({ label: "LA County Assessor (parcel)", url: `https://portal.assessor.lacounty.gov/parceldetail/${parcel}` });
    manualLinks.push({ label: "LA Recorder (deeds)", url: `https://www.lavote.gov/home/county-clerk/property-document-records/property-document-search` });
  }
  if (state === "IL" && county.includes("cook")) {
    if (parcel.length >= 10) manualLinks.push({ label: "Cook County Assessor (PIN)", url: `https://www.cookcountyassessor.com/pin/${parcel}` });
    manualLinks.push({ label: "Cook County Recorder", url: `https://crs.cookcountyclerkil.gov/` });
  }
  if (lead.owner_name) {
    manualLinks.push({ label: "Search owner on Google", url: `https://www.google.com/search?q=${ownerQ}+${addr}` });
    manualLinks.push({ label: "Search owner on LinkedIn", url: `https://www.google.com/search?q=site%3Alinkedin.com%2Fin+${ownerQ}` });
    if (/llc|inc|corp|trust|company|co\.|holdings|properties|partners/i.test(lead.owner_name)) {
      manualLinks.push({ label: "OpenCorporates lookup", url: `https://opencorporates.com/companies?q=${ownerQ}&jurisdiction_code=us_${state.toLowerCase()}` });
    }
  }
  if (lead.source_record_url) {
    manualLinks.unshift({ label: "Original deed record", url: lead.source_record_url });
  }

  if (!uniqueSources.length && !manualLinks.length) return null;

  return (
    <div className="px-6 py-5 border-b border-border">
      <div className="kpi-label mb-3">Reference links</div>

      {manualLinks.length > 0 && (
        <div className="mb-4">
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            Public records · Verify manually
          </div>
          <div className="flex flex-wrap gap-2">
            {manualLinks.map((l, i) => (
              <a
                key={i}
                href={l.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2 py-1 bg-secondary hover:bg-accent/10 hover:text-accent font-mono text-[11px] transition-colors"
              >
                <ExternalLink className="h-3 w-3" /> {l.label}
              </a>
            ))}
          </div>
        </div>
      )}

      {uniqueSources.length > 0 && (
        <div>
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            Sources used by Profiler
          </div>
          <ul className="space-y-1">
            {uniqueSources.map((url, i) => {
              let host = url;
              try { host = new URL(url).hostname.replace(/^www\./, ""); } catch (_) {}
              return (
                <li key={i} className="text-xs">
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-accent transition-colors"
                  >
                    <ExternalLink className="h-3 w-3 shrink-0" />
                    <span className="font-mono text-[10px] uppercase tracking-wider w-40 shrink-0 truncate">{host}</span>
                    <span className="truncate max-w-[260px]">{url}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
};

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="px-6 py-5 border-b border-border">
    <div className="kpi-label mb-3">{title}</div>
    {children}
  </div>
);

const Fact = ({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) => (
  <div className="bg-card p-4">
    <div className="kpi-label">{label}</div>
    <div className={`font-display text-2xl mt-1 leading-none ${accent ? "text-accent" : ""}`}>{value}</div>
    {sub && <div className="text-[10px] font-mono text-muted-foreground mt-1">{sub}</div>}
  </div>
);

const ContactPill = ({ icon, value, link }: { icon: React.ReactNode; value?: string | null; link?: boolean }) => {
  if (!value) return <span className="inline-flex items-center gap-1 px-2 py-1 bg-muted text-muted-foreground font-mono text-[10px] uppercase tracking-wider">{icon} missing</span>;
  return link ? (
    <a href={value} target="_blank" rel="noopener" className="inline-flex items-center gap-1 px-2 py-1 bg-secondary hover:bg-accent/10 font-mono text-xs">{icon} {value.slice(0, 32)}</a>
  ) : (
    <span className="inline-flex items-center gap-1 px-2 py-1 bg-secondary font-mono text-xs">{icon} {value}</span>
  );
};
