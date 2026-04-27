import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { fmtRelative } from "@/lib/format";
import { Calendar, Save } from "lucide-react";
import { toast } from "sonner";

export const NextActionEditor = ({ lead }: { lead: any }) => {
  const qc = useQueryClient();
  const [text, setText] = useState(lead.next_action ?? "");
  const [date, setDate] = useState(lead.next_action_at ? new Date(lead.next_action_at).toISOString().slice(0, 10) : "");
  const [saving, setSaving] = useState(false);
  const dirty = text !== (lead.next_action ?? "") || date !== (lead.next_action_at ? new Date(lead.next_action_at).toISOString().slice(0, 10) : "");

  const overdue = lead.next_action_at && new Date(lead.next_action_at) < new Date();

  const save = async () => {
    setSaving(true);
    const { error } = await supabase.from("leads").update({
      next_action: text.trim() || null,
      next_action_at: date ? new Date(date).toISOString() : null,
    }).eq("id", lead.id);
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    qc.invalidateQueries({ queryKey: ["lead", lead.id] });
    qc.invalidateQueries({ queryKey: ["leads"] });
    toast.success("Next step updated");
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Calendar className={`h-3.5 w-3.5 ${overdue ? "text-urgent" : "text-muted-foreground"}`} />
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Follow-up call, send case study, intro to broker…"
          className="rounded-none h-9 text-sm flex-1"
        />
        <Input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-none h-9 w-[150px] font-mono text-xs"
        />
        <Button
          size="sm"
          onClick={save}
          disabled={!dirty || saving}
          className="rounded-none h-9 bg-accent text-accent-foreground hover:bg-accent/90 font-mono text-[10px] uppercase tracking-wider"
        >
          <Save className="h-3 w-3 mr-1" /> Save
        </Button>
      </div>
      {lead.next_action_at && (
        <div className={`text-[11px] font-mono ${overdue ? "text-urgent" : "text-muted-foreground"}`}>
          {overdue ? "Overdue · " : "Due "}{fmtRelative(lead.next_action_at)}
        </div>
      )}
    </div>
  );
};
