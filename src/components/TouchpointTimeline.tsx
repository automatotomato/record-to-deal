import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { fmtRelative } from "@/lib/format";
import { useAuth } from "@/hooks/useAuth";
import { Mail, Phone, Calendar, MessageSquare, StickyNote, Linkedin, Send, Loader2, ChevronDown } from "lucide-react";
import { toast } from "sonner";

const KIND_META: Record<string, { icon: any; label: string; color: string }> = {
  email_sent:   { icon: Mail,         label: "Email sent",   color: "text-accent" },
  email_reply:  { icon: Mail,         label: "Email reply",  color: "text-emerald-600" },
  call:         { icon: Phone,        label: "Call",         color: "text-foreground" },
  meeting:      { icon: Calendar,     label: "Meeting",      color: "text-emerald-600" },
  note:         { icon: StickyNote,   label: "Note",         color: "text-muted-foreground" },
  linkedin_msg: { icon: Linkedin,     label: "LinkedIn",     color: "text-blue-600" },
  sms:          { icon: MessageSquare,label: "SMS",          color: "text-foreground" },
};

const OUTCOMES = [
  { v: "no_answer",      l: "No answer" },
  { v: "left_voicemail", l: "Left voicemail" },
  { v: "replied",        l: "Replied" },
  { v: "meeting_booked", l: "Meeting booked" },
  { v: "not_interested", l: "Not interested" },
  { v: "bad_contact",    l: "Bad contact info" },
];

export const TouchpointTimeline = ({ leadId }: { leadId: string }) => {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<string>("note");
  const [outcome, setOutcome] = useState<string>("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  const { data: touchpoints } = useQuery({
    queryKey: ["touchpoints", leadId],
    queryFn: async () => {
      const { data } = await supabase
        .from("lead_touchpoints")
        .select("*")
        .eq("lead_id", leadId)
        .order("occurred_at", { ascending: false })
        .limit(100);
      return data ?? [];
    },
  });

  const submit = async () => {
    if (!body.trim() && kind !== "call") {
      toast.error("Add a note or detail");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("lead_touchpoints").insert({
      lead_id: leadId,
      user_id: user?.id ?? null,
      kind,
      direction: "outbound",
      body: body.trim() || null,
      outcome: outcome || null,
    });
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    setBody(""); setOutcome(""); setOpen(false);
    qc.invalidateQueries({ queryKey: ["touchpoints", leadId] });
    qc.invalidateQueries({ queryKey: ["leads"] });
    toast.success("Logged");
  };

  return (
    <div>
      {/* Quick log buttons */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        {(["call", "note", "linkedin_msg", "meeting", "sms"] as const).map((k) => {
          const meta = KIND_META[k];
          const Icon = meta.icon;
          return (
            <Button
              key={k}
              size="sm"
              variant={kind === k && open ? "default" : "outline"}
              onClick={() => { setKind(k); setOpen(true); }}
              className="rounded-none h-7 font-mono uppercase text-[10px] tracking-wider"
            >
              <Icon className="h-3 w-3 mr-1" /> Log {meta.label.toLowerCase()}
            </Button>
          );
        })}
      </div>

      {open && (
        <div className="border border-border bg-secondary/30 p-3 mb-3 space-y-2">
          {(kind === "call" || kind === "linkedin_msg" || kind === "meeting") && (
            <Select value={outcome} onValueChange={setOutcome}>
              <SelectTrigger className="rounded-none h-8 font-mono text-xs">
                <SelectValue placeholder="Outcome (optional)" />
              </SelectTrigger>
              <SelectContent>
                {OUTCOMES.map((o) => (
                  <SelectItem key={o.v} value={o.v} className="font-mono text-xs">{o.l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="What happened?"
            className="rounded-none text-sm min-h-20"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} className="rounded-none h-7 font-mono text-[10px] uppercase tracking-wider">
              Cancel
            </Button>
            <Button size="sm" onClick={submit} disabled={saving} className="rounded-none h-7 bg-accent text-accent-foreground hover:bg-accent/90 font-mono text-[10px] uppercase tracking-wider">
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3 mr-1" />} Save
            </Button>
          </div>
        </div>
      )}

      {/* Timeline */}
      {!touchpoints?.length ? (
        <div className="text-xs text-muted-foreground italic">
          No touchpoints yet. Log a call, send an email, or add a note above.
        </div>
      ) : (
        <ul className="space-y-2">
          {touchpoints.map((t: any) => {
            const meta = KIND_META[t.kind] ?? KIND_META.note;
            const Icon = meta.icon;
            return (
              <li key={t.id} className="border-l-2 border-accent pl-3 py-1">
                <div className="flex items-baseline gap-2 text-xs">
                  <Icon className={`h-3 w-3 shrink-0 ${meta.color}`} />
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {meta.label}{t.direction === "inbound" ? " · in" : ""}
                  </span>
                  {t.outcome && (
                    <span className="font-mono text-[10px] uppercase tracking-wider bg-secondary px-1.5 py-0.5">
                      {t.outcome.replace(/_/g, " ")}
                    </span>
                  )}
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {fmtRelative(t.occurred_at)}
                  </span>
                </div>
                {t.subject && <div className="text-xs font-medium mt-1">{t.subject}</div>}
                {t.body && <div className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap leading-relaxed">{t.body}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
