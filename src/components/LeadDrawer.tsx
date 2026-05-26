import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { fmtMoney, fmtDate, fmtRelative, daysSince } from "@/lib/format";
import {
  Loader2, Sparkles, AlertCircle, ExternalLink, Mail, Phone,
  Link2 as Linkedin, Send, RefreshCw, Building2, MoreHorizontal,
  ChevronDown, Target, Compass, MessageSquare, ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import { TouchpointTimeline } from "./TouchpointTimeline";
import { NextActionEditor } from "./NextActionEditor";
import { ReadinessPill } from "./ReadinessPill";

const isEmptyValue = (v: unknown): boolean => {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" || t === "—" || t === "-" || t === "N/A" || t.toLowerCase() === "unknown" || t.toLowerCase() === "null";
  }
  if (Array.isArray(v)) return v.length === 0;
  return false;
};

export const LeadDrawer = ({ leadId, onClose }: { leadId: string; onClose: () => void }) => {
  const qc = useQueryClient();
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [briefing, setBriefing] = useState(false);
  const [recipientOverride, setRecipientOverride] = useState("");
  

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

  const generateBrief = async () => {
    setBriefing(true);
    toast.loading("Regenerating AI brief…", { id: "brief" });
    try {
      const { data, error } = await supabase.functions.invoke("lead-brief", { body: { lead_id: leadId } });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success("Brief refreshed", { id: "brief" });
      qc.invalidateQueries({ queryKey: ["lead", leadId] });
    } catch (e: any) {
      toast.error(`Brief failed: ${e.message}`, { id: "brief" });
    } finally {
      setBriefing(false);
    }
  };

  const findContact = async (opts: { force?: boolean; website?: string } = {}) => {
    setDiscovering(true);
    toast.loading("Hunting for seller contact info…", { id: "disc" });
    try {
      const { data, error } = await supabase.functions.invoke("seller-discovery", {
        body: { lead_id: leadId, force: opts.force ?? true, company_website: opts.website },
      });
      if (error) throw error;
      const status = (data as any)?.status;
      const email = (data as any)?.discovery?.email;
      if (email) toast.success(`Found ${email}`, { id: "disc" });
      else if (status === "partial") toast.success("Found partial contact (no email yet)", { id: "disc" });
      else toast.error("No contact found — try giving us the company website", { id: "disc" });
      qc.invalidateQueries({ queryKey: ["lead", leadId] });
      qc.invalidateQueries({ queryKey: ["activities", leadId] });
      qc.invalidateQueries({ queryKey: ["emails", leadId] });
      qc.invalidateQueries({ queryKey: ["leads"] });
    } catch (e: any) {
      toast.error(`Discovery failed: ${e.message}`, { id: "disc" });
    } finally {
      setDiscovering(false);
    }
  };

  const draftEmail = async () => {
    setDrafting(true);
    toast.loading("Queuing draft…", { id: "draft" });
    try {
      const { error } = await supabase.from("pipeline_jobs").insert([
        { kind: "draft_outreach_step", lead_id: leadId, priority: 30 },
      ]);
      if (error) throw error;
      toast.success("Queued — refresh in a minute", { id: "draft" });
    } catch (e: any) {
      toast.error(`Couldn't queue: ${e.message}`, { id: "draft" });
    } finally {
      setDrafting(false);
    }
  };

  const sendEmail = async (emailRow: any, lead: any) => {
    const to = recipientOverride.trim() || emailRow.to_email || lead.decision_maker_email || lead.contact_email;
    if (!to) { toast.error("Add a recipient email first"); return; }
    setSending(true);
    toast.loading("Sending from your Gmail…", { id: "send" });
    try {
      const { data, error } = await supabase.functions.invoke("send-outreach-email", {
        body: { email_id: emailRow.id, to_email: to },
      });
      if (error) throw error;
      if ((data as any)?.error === "gmail_not_connected") {
        toast.error("Connect your Gmail account first (Connectors → Google Mail)", { id: "send", duration: 8000 });
      } else {
        toast.success("Sent ✓", { id: "send" });
      }
      qc.invalidateQueries({ queryKey: ["emails", leadId] });
      qc.invalidateQueries({ queryKey: ["touchpoints", leadId] });
      qc.invalidateQueries({ queryKey: ["lead", leadId] });
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
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <ReadinessPill readiness={lead.readiness} dark />
                {lead.is_urgent && (
                  <span className="tier-pill bg-card text-urgent flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" /> URGENT · {daysSince(lead.sale_date)}d ago
                  </span>
                )}
                <span className="font-mono text-[10px] uppercase tracking-wider text-primary-foreground/60 ml-auto">
                  Score {lead.score} · {lead.state}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-primary-foreground/80 hover:text-primary-foreground hover:bg-white/10">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={generateBrief} disabled={briefing}>
                      <Sparkles className="h-3.5 w-3.5 mr-2" /> Regenerate brief
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => findContact({ force: true })} disabled={discovering}>
                      <RefreshCw className="h-3.5 w-3.5 mr-2" /> Re-run contact hunt
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={draftEmail} disabled={drafting}>
                      <Mail className="h-3.5 w-3.5 mr-2" /> Draft outreach email
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <h2 className="font-display text-3xl leading-tight">{lead.property_address ?? "Unknown property"}</h2>
              <p className="font-mono text-xs uppercase tracking-wider text-primary-foreground/70 mt-1">
                {lead.property_city}, {lead.state} {lead.property_zip}
                {lead.county && ` · ${lead.county} County`}
              </p>
            </div>

            {/* AI DEAL BRIEF — first */}
            <AIBriefSection
              brief={lead.ai_brief}
              generatedAt={lead.ai_brief_generated_at}
              loading={briefing}
              onGenerate={generateBrief}
              readiness={lead.readiness}
            />

            {/* CONTACT CARD */}
            <ContactCard lead={lead} onFind={() => findContact({ force: true })} discovering={discovering} />

            {/* TOUCHPOINT MESSAGES — 3 personalized openers */}
            <TouchpointMessages lead={lead} />


            {/* PROPERTY SNAPSHOT */}
            <PropertySnapshot lead={lead} />

            {/* 1031 FIT SCORE */}
            <FitScoreSection lead={lead} />

            {/* OUTREACH (if reachable) */}
            {(lead.decision_maker_email || lead.contact_email) && (
              <OutreachSection
                lead={lead}
                emails={emails}
                drafting={drafting}
                sending={sending}
                onDraft={draftEmail}
                onSend={sendEmail}
                recipientOverride={recipientOverride}
                setRecipientOverride={setRecipientOverride}
              />
            )}

            {/* WORKFLOW + NEXT ACTION */}
            <Section title="Workflow">
              <div className="flex items-center gap-2 mb-4">
                <Select value={lead.status} onValueChange={updateStatus}>
                  <SelectTrigger className="rounded-none h-9 w-[200px] font-mono text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["new", "reviewing", "contacted", "replied", "meeting", "won", "dead"].map((s) => (
                      <SelectItem key={s} value={s} className="font-mono text-xs">{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <NextActionEditor lead={lead} />
            </Section>

            {/* TOUCHPOINTS */}
            <Section title="Touchpoints">
              <TouchpointTimeline leadId={leadId} />
            </Section>

            {/* RESEARCH SOURCES — collapsed */}
            <ResearchSources lead={lead} activities={activities} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
};

/* ===================== Sections ===================== */

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="px-6 py-5 border-b border-border">
    <div className="kpi-label mb-3">{title}</div>
    {children}
  </div>
);

const Field = ({ label, value }: { label: string; value: React.ReactNode }) => {
  if (isEmptyValue(value as any)) return null;
  return (
    <div>
      <div className="kpi-label">{label}</div>
      <div className="text-sm mt-0.5">{value}</div>
    </div>
  );
};

const AIBriefSection = ({
  brief, generatedAt, loading, onGenerate, readiness,
}: {
  brief: { summary?: string; why_good?: string; approach?: string; replacement_market_fit?: string; best_next_action?: string } | null;
  generatedAt: string | null;
  loading: boolean;
  onGenerate: () => void;
  readiness: string;
}) => {
  const has = brief && (brief.summary || brief.why_good || brief.approach || brief.replacement_market_fit || brief.best_next_action);

  return (
    <Section title="AI Deal Brief">
      {!has ? (
        <div className="bg-secondary/40 border border-dashed border-border p-4 text-center">
          {readiness === "researching" || readiness === "needs_contact_info" ? (
            <>
              <Loader2 className="h-4 w-4 mx-auto animate-spin text-muted-foreground mb-2" />
              <div className="text-xs text-muted-foreground">
                Brief is being generated automatically. Refresh in a minute.
              </div>
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4 mx-auto text-muted-foreground mb-2" />
              <div className="text-xs text-muted-foreground mb-3">No AI brief yet for this lead.</div>
              <Button
                size="sm"
                onClick={onGenerate}
                disabled={loading}
                className="rounded-none bg-accent text-accent-foreground hover:bg-accent/90 font-mono text-[10px] uppercase tracking-wider"
              >
                {loading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Sparkles className="h-3 w-3 mr-1" />}
                Generate brief
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {brief?.best_next_action && (
            <div className="bg-accent/10 border-l-4 border-accent p-3">
              <div className="flex items-start gap-2">
                <ArrowRight className="h-4 w-4 text-accent mt-0.5 shrink-0" />
                <div>
                  <div className="kpi-label text-accent mb-1">Best next action</div>
                  <p className="text-sm font-medium leading-relaxed">{brief.best_next_action}</p>
                </div>
              </div>
            </div>
          )}
          {brief?.summary && (
            <BriefBlock icon={<Compass className="h-3.5 w-3.5" />} title="Summary" body={brief.summary} />
          )}
          {brief?.why_good && (
            <BriefBlock icon={<Target className="h-3.5 w-3.5" />} title="Why this is a good 1031 lead" body={brief.why_good} />
          )}
          {brief?.approach && (
            <BriefBlock icon={<MessageSquare className="h-3.5 w-3.5" />} title="How to approach" body={brief.approach} />
          )}
          {brief?.replacement_market_fit && (
            <BriefBlock icon={<Building2 className="h-3.5 w-3.5" />} title="Replacement market fit" body={brief.replacement_market_fit} />
          )}
          {generatedAt && (
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70 pt-2 border-t border-border">
              Generated {fmtRelative(generatedAt)}
            </div>
          )}
        </div>
      )}
    </Section>
  );
};

const BriefBlock = ({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) => (
  <div>
    <div className="flex items-center gap-1.5 kpi-label mb-1.5">{icon}{title}</div>
    <p className="text-sm leading-relaxed whitespace-pre-line">{body}</p>
  </div>
);

const ContactCard = ({ lead, onFind, discovering }: { lead: any; onFind: () => void; discovering: boolean }) => {
  const email = lead.decision_maker_email || lead.contact_email;
  const phone = lead.decision_maker_phone || lead.contact_phone;
  const linkedin = lead.decision_maker_linkedin || lead.contact_linkedin;
  const website = lead.company_website;
  const name = lead.decision_maker_name || lead.owner_name;
  const role = lead.decision_maker_role;
  const owner = lead.owner_name;

  const hasAny = !isEmptyValue(email) || !isEmptyValue(phone) || !isEmptyValue(linkedin) || !isEmptyValue(website);

  return (
    <Section title="Contact">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          {!isEmptyValue(name) && <div className="text-lg font-semibold">{name}</div>}
          {(!isEmptyValue(role) || (!isEmptyValue(owner) && owner !== name)) && (
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5">
              {!isEmptyValue(role) ? role : ""}
              {!isEmptyValue(role) && !isEmptyValue(owner) && owner !== name ? " · " : ""}
              {!isEmptyValue(owner) && owner !== name ? owner : ""}
            </div>
          )}
        </div>
        {!hasAny && (
          <Button
            size="sm"
            onClick={onFind}
            disabled={discovering}
            className="rounded-none bg-foreground text-background hover:bg-foreground/90 font-mono text-[10px] uppercase tracking-wider shrink-0"
          >
            {discovering ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
            Find contact
          </Button>
        )}
      </div>

      {hasAny ? (
        <div className="space-y-2">
          {!isEmptyValue(email) && <ContactRow icon={<Mail className="h-3.5 w-3.5" />} value={email} href={`mailto:${email}`} />}
          {!isEmptyValue(phone) && <ContactRow icon={<Phone className="h-3.5 w-3.5" />} value={phone} href={`tel:${phone}`} />}
          {!isEmptyValue(linkedin) && <ContactRow icon={<Linkedin className="h-3.5 w-3.5" />} value={linkedin} href={linkedin} external />}
          {!isEmptyValue(website) && <ContactRow icon={<Building2 className="h-3.5 w-3.5" />} value={website} href={website.startsWith("http") ? website : `https://${website}`} external />}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground italic">No contact details yet — searching automatically.</div>
      )}
    </Section>
  );
};

const ContactRow = ({ icon, value, href, external }: { icon: React.ReactNode; value: string; href: string; external?: boolean }) => (
  <a
    href={href}
    target={external ? "_blank" : undefined}
    rel={external ? "noopener noreferrer" : undefined}
    className="flex items-center gap-2 text-sm font-mono bg-secondary hover:bg-accent/10 hover:text-accent transition-colors px-3 py-2"
  >
    {icon}
    <span className="truncate">{value}</span>
    {external && <ExternalLink className="h-3 w-3 ml-auto text-muted-foreground" />}
  </a>
);

const PropertySnapshot = ({ lead }: { lead: any }) => {
  const stateTaxRate = typeof lead.state_tax_rate === "number" ? lead.state_tax_rate : null;
  const isHighTax = stateTaxRate !== null && stateTaxRate >= 0.06;

  return (
    <Section title="Property snapshot">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Property" value={lead.property_address} />
        <Field label="Type" value={lead.property_type} />
        <Field
          label="Sale"
          value={
            lead.sale_date && (
              <span>
                {fmtDate(lead.sale_date)}
                <span className="text-muted-foreground font-mono text-[10px] ml-1">({fmtRelative(lead.sale_date)})</span>
              </span>
            )
          }
        />
        <Field label="Sale price" value={lead.sale_price ? fmtMoney(lead.sale_price, { compact: true }) : null} />
        <Field label="Owner" value={lead.owner_name} />
        <Field label="Owner type" value={lead.owner_type !== "Unknown" ? lead.owner_type : null} />
        <Field label="Held" value={lead.ownership_years ? `${lead.ownership_years} years` : null} />
        <Field label="Assessed value" value={lead.assessed_value ? fmtMoney(lead.assessed_value, { compact: true }) : null} />
        {isHighTax && (
          <Field label="State tax" value={<span className="text-urgent font-medium">High-tax state ({(stateTaxRate! * 100).toFixed(1)}%)</span>} />
        )}
      </div>
    </Section>
  );
};

const SCORE_LABELS: Record<string, string> = {
  high_tax_state: "High-tax origin state",
  investment_property: "Investment property type",
  entity_owner: "Entity owner (LLC/Trust)",
  sale_size: "Large sale size",
  recent_sale: "Recent sale (45-day window)",
  long_hold: "Long ownership history",
  trigger_boost: "Trigger event",
};

const FitScoreSection = ({ lead }: { lead: any }) => {
  const breakdown = (lead.score_breakdown ?? {}) as Record<string, number>;
  const factors = Object.entries(breakdown).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const total = lead.total_tax_exposure as number | null;
  const conf = lead.enrichment_confidence ?? 0;
  const redFlags: string[] = [];
  if (!lead.owner_name) redFlags.push("Owner unknown");
  if (lead.tier === "DISQUALIFIED") redFlags.push("Disqualified");

  if (!factors.length && !total && !lead.score) return null;

  return (
    <Section title="1031 fit score">
      <div className="flex items-baseline gap-3 mb-4">
        <div className="font-display text-4xl tabular leading-none">{lead.score ?? 0}</div>
        <div className="text-xs text-muted-foreground">/ 100</div>
        <div className="ml-auto text-right">
          <div className="kpi-label">Confidence</div>
          <div className="font-mono text-sm tabular">{conf}%</div>
        </div>
      </div>

      {factors.length > 0 && (
        <div className="space-y-1.5 mb-4">
          {factors.map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-2 border-l-2 border-accent pl-3">
              <div className="text-xs">{SCORE_LABELS[k] ?? k.replace(/_/g, " ")}</div>
              <div className="font-mono text-xs tabular text-accent shrink-0">+{v}</div>
            </div>
          ))}
        </div>
      )}

      {total && (
        <div className="bg-secondary/50 p-3 border-l-2 border-accent">
          <div className="kpi-label">Estimated tax exposure</div>
          <div className="font-display text-2xl text-accent mt-1 leading-none">{fmtMoney(total, { compact: true })}</div>
          <p className="text-[11px] text-muted-foreground italic mt-2 leading-snug">
            A 1031 exchange could defer ~100% of this.
          </p>
        </div>
      )}

      {redFlags.length > 0 && (
        <div className="mt-4 pt-3 border-t border-border">
          <div className="kpi-label text-urgent mb-1.5">Red flags</div>
          <ul className="space-y-0.5">
            {redFlags.map((r, i) => <li key={i} className="text-xs text-urgent">• {r}</li>)}
          </ul>
        </div>
      )}
    </Section>
  );
};

const OutreachSection = ({
  lead, emails, drafting, sending, onDraft, onSend, recipientOverride, setRecipientOverride,
}: any) => {
  const latestDraft = emails?.find((e: any) => e.status === "draft");
  const defaultTo = latestDraft?.to_email || lead.decision_maker_email || lead.contact_email || "";

  return (
    <Section title="Outreach draft">
      {!latestDraft ? (
        <div>
          <p className="text-xs text-muted-foreground mb-3">No draft yet. Generate one tailored to this lead.</p>
          <Button
            size="sm"
            onClick={onDraft}
            disabled={drafting}
            className="rounded-none bg-accent text-accent-foreground hover:bg-accent/90 font-mono text-[10px] uppercase tracking-wider"
          >
            {drafting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Sparkles className="h-3 w-3 mr-1" />}
            Generate email draft
          </Button>
        </div>
      ) : (
        <div className="space-y-2 border border-border bg-secondary/30 p-3">
          <div className="kpi-label">Subject</div>
          <div className="text-sm font-medium">{latestDraft.subject}</div>
          <div className="kpi-label mt-2">Body</div>
          <pre className="text-sm whitespace-pre-wrap font-sans leading-relaxed">{latestDraft.body}</pre>
          <div className="mt-3 pt-3 border-t border-border space-y-2">
            <div className="kpi-label">Send to</div>
            <Input
              type="email"
              placeholder={defaultTo || "recipient@example.com"}
              value={recipientOverride}
              onChange={(e: any) => setRecipientOverride(e.target.value)}
              className="rounded-none h-8 font-mono text-xs"
            />
            <Button
              size="sm"
              onClick={() => onSend(latestDraft, lead)}
              disabled={sending || (!recipientOverride.trim() && !defaultTo)}
              className="rounded-none bg-primary text-primary-foreground hover:bg-primary/90 font-mono text-[10px] uppercase tracking-wider"
            >
              {sending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
              Send from my Gmail
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
};

const ResearchSources = ({ lead, activities }: { lead: any; activities: any[] | undefined }) => {
  const profilerRuns = (activities ?? []).filter((a) => a.kind === "profiler_run");
  const sourceUrls: string[] = [];
  for (const run of profilerRuns) {
    const s = run?.payload?.sources;
    if (Array.isArray(s)) sourceUrls.push(...s.filter((u: any) => typeof u === "string" && u.startsWith("http")));
  }
  const uniqueSources = Array.from(new Set(sourceUrls)).slice(0, 20);

  const manualLinks: { label: string; url: string }[] = [];
  const state = (lead.state ?? "").toUpperCase();
  const county = (lead.county ?? "").toLowerCase();
  const parcel = (lead.parcel_number ?? "").replace(/[^0-9]/g, "");
  const addr = encodeURIComponent(lead.property_address ?? "");
  const ownerQ = encodeURIComponent(lead.owner_name ?? "");

  if (state === "NV" && county.includes("clark")) {
    manualLinks.push({ label: "Clark County Assessor", url: `https://maps.clarkcountynv.gov/assessor/AssessorParcelDetail/parceldetail.aspx?hdnParcel=${parcel}` });
    manualLinks.push({ label: "Clark County Recorder", url: `https://recorder.co.clark.nv.us/RecorderEcommerce/` });
  }
  if (lead.owner_name) {
    manualLinks.push({ label: "Search owner on Google", url: `https://www.google.com/search?q=${ownerQ}+${addr}` });
    manualLinks.push({ label: "Search owner on LinkedIn", url: `https://www.google.com/search?q=site%3Alinkedin.com%2Fin+${ownerQ}` });
    if (/llc|inc|corp|trust|company|co\.|holdings|properties|partners/i.test(lead.owner_name)) {
      manualLinks.push({ label: "OpenCorporates lookup", url: `https://opencorporates.com/companies?q=${ownerQ}&jurisdiction_code=us_${state.toLowerCase()}` });
    }
  }
  if (lead.source_record_url) manualLinks.unshift({ label: "Original deed record", url: lead.source_record_url });

  const related = Array.isArray(lead.related_entities) ? lead.related_entities : [];
  const mailing = lead.mailing_address && lead.mailing_address !== lead.property_address ? lead.mailing_address : null;

  if (!uniqueSources.length && !manualLinks.length && !related.length && !mailing) return null;

  return (
    <details className="border-b border-border group">
      <summary className="px-6 py-4 cursor-pointer flex items-center justify-between hover:bg-secondary/40 list-none">
        <div className="kpi-label">View Research Sources</div>
        <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="px-6 pb-5 space-y-4">
        {mailing && (
          <Field label="Mailing address (county records)" value={<span className="font-mono text-xs">{mailing}</span>} />
        )}
        {related.length > 0 && (
          <div>
            <div className="kpi-label mb-1">Related entities</div>
            <div className="flex flex-wrap gap-1">
              {related.slice(0, 12).map((e: any, i: number) => (
                <span key={i} className="font-mono text-[10px] bg-secondary px-2 py-0.5">{e.name}</span>
              ))}
            </div>
          </div>
        )}
        {manualLinks.length > 0 && (
          <div>
            <div className="kpi-label mb-2">Public records · Verify manually</div>
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
            <div className="kpi-label mb-2">Sources used by Profiler</div>
            <ul className="space-y-1">
              {uniqueSources.map((url, i) => {
                let host = url;
                try { host = new URL(url).hostname.replace(/^www\./, ""); } catch (_) {}
                return (
                  <li key={i} className="text-xs">
                    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-accent transition-colors">
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
    </details>
  );
};
