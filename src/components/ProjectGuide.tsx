import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Lightbulb,
  Send,
  CheckCircle,
  Clock,
  Search,
  Radar,
  Target,
  Mail,
  Phone,
  User,
  MessageSquare,
  AlertCircle,
} from "lucide-react";

const FEEDBACK_CATEGORIES = [
  { value: "general", label: "General feedback" },
  { value: "feature", label: "Feature request" },
  { value: "bug", label: "Bug report" },
  { value: "data", label: "Data correction" },
  { value: "market", label: "Market / county request" },
];

const STATUS_META: Record<string, { label: string; classes: string }> = {
  open: { label: "Open", classes: "bg-warm text-warm-foreground" },
  "in-progress": { label: "In progress", classes: "bg-accent text-accent-foreground" },
  resolved: { label: "Resolved", classes: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" },
  closed: { label: "Closed", classes: "bg-muted text-muted-foreground" },
};

export const ProjectGuide = () => {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", email: "", category: "general", message: "" });
  const [submitting, setSubmitting] = useState(false);

  const { data: feedback } = useQuery({
    queryKey: ["client-feedback"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("client_feedback")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const submitFeedback = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.email.trim() || !form.message.trim()) {
      toast.error("Please fill in all fields.");
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.from("client_feedback").insert({
      name: form.name.trim(),
      email: form.email.trim(),
      category: form.category,
      message: form.message.trim(),
    });
    setSubmitting(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Feedback submitted. Thank you!");
    setForm({ name: "", email: "", category: "general", message: "" });
    qc.invalidateQueries({ queryKey: ["client-feedback"] });
  };

  return (
    <div className="p-8 space-y-10 max-w-5xl">
      {/* Header */}
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">
          About this project
        </div>
        <h1 className="font-display text-4xl leading-none">Project Guide.</h1>
        <p className="mt-3 text-sm text-muted-foreground max-w-2xl leading-relaxed">
          The 1031 Intelligence Desk automatically surfaces property sellers who may benefit from a 1031 exchange — 
          deferring capital-gains tax by reinvesting proceeds into like-kind property. Below is how the system works, 
          what each pipeline stage means, and how you can request changes.
        </p>
      </div>

      {/* How it works */}
      <section className="space-y-4">
        <h2 className="kpi-label">How it works</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StepCard
            icon={<Radar className="h-5 w-5" />}
            title="Daily scan"
            description="Every morning at 8 AM UTC the system scans enabled county recorder websites for new property sales."
          />
          <StepCard
            icon={<Target className="h-5 w-5" />}
            title="Smart filtering"
            description="Sales are matched against our criteria: price threshold, entity type, tax exposure, and 1031 fit."
          />
          <StepCard
            icon={<CheckCircle className="h-5 w-5" />}
            title="Ready for outreach"
            description="Qualified leads land in your pipeline with contact angles, priority scores, and talking points."
          />
        </div>
      </section>

      {/* Pipeline stages */}
      <section className="space-y-4">
        <h2 className="kpi-label">Pipeline stages</h2>
        <div className="border border-border bg-card divide-y divide-border">
          <StageRow
            stage="Researching"
            badge={<Badge variant="secondary" className="font-mono text-[10px]">Researching</Badge>}
            description="Lead was found but is still being enriched. Contact info, entity links, and tax estimates are being gathered."
          />
          <StageRow
            stage="Candidate"
            badge={<Badge className="bg-urgent text-urgent-foreground font-mono text-[10px]">Candidate</Badge>}
            description="Strong 1031 fit with verified sale date and estimated tax exposure. Ready for priority review."
          />
          <StageRow
            stage="Presale"
            badge={<Badge className="bg-warm text-warm-foreground font-mono text-[10px]">Presale</Badge>}
            description="Contacted or in early conversation. Track follow-ups and next actions here."
          />
          <StageRow
            stage="Active"
            badge={<Badge className="bg-accent text-accent-foreground font-mono text-[10px]">Active</Badge>}
            description="Engaged lead moving toward an exchange agreement."
          />
        </div>
      </section>

      {/* Outreach channels */}
      <section className="space-y-4">
        <h2 className="kpi-label">Outreach channels</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <ChannelCard
            icon={<Mail className="h-4 w-4" />}
            title="Email"
            description="Personalized openers referencing the seller's city, sale price, and estimated tax exposure."
          />
          <ChannelCard
            icon={<Phone className="h-4 w-4" />}
            title="Phone"
            description="Scripts include objection handlers for 'already handled' and 'not interested' responses."
          />
          <ChannelCard
            icon={<User className="h-4 w-4" />}
            title="LinkedIn"
            description="Connection request templates tailored to the decision maker's role and property profile."
          />
        </div>
      </section>

      {/* Client feedback & changes */}
      <section className="space-y-4">
        <h2 className="kpi-label">Submit a change or request</h2>
        <Tabs defaultValue="submit" className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="submit" className="font-mono text-xs uppercase tracking-wider">
              Submit request
            </TabsTrigger>
            <TabsTrigger value="submissions" className="font-mono text-xs uppercase tracking-wider">
              Submissions ({feedback?.length ?? 0})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="submit">
            <Card className="border-border">
              <CardHeader>
                <CardTitle className="font-display text-lg flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-accent" />
                  Tell us what you need
                </CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={submitFeedback} className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Name</label>
                      <Input
                        value={form.name}
                        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                        placeholder="Your name"
                        className="bg-secondary/30"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Email</label>
                      <Input
                        type="email"
                        value={form.email}
                        onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                        placeholder="you@company.com"
                        className="bg-secondary/30"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Category</label>
                    <select
                      value={form.category}
                      onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                      className="w-full h-10 px-3 rounded-md border border-input bg-secondary/30 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      {FEEDBACK_CATEGORIES.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Message</label>
                    <Textarea
                      value={form.message}
                      onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
                      placeholder="Describe the change, feature, or correction you need..."
                      rows={5}
                      className="bg-secondary/30 resize-none"
                    />
                  </div>
                  <Button type="submit" disabled={submitting} className="font-mono uppercase tracking-wider text-xs">
                    {submitting ? (
                      <Clock className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Send className="w-4 h-4 mr-2" />
                    )}
                    {submitting ? "Sending…" : "Submit request"}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="submissions">
            <div className="border border-border bg-card">
              {(!feedback || feedback.length === 0) ? (
                <div className="p-8 text-center text-sm text-muted-foreground italic">
                  No submissions yet. Use the Submit request tab to send one.
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {feedback.map((item: any) => (
                    <div key={item.id} className="p-4 flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm">{item.name}</span>
                          <span className="text-xs text-muted-foreground">{item.email}</span>
                          <Badge
                            variant="secondary"
                            className={`font-mono text-[10px] ${
                              STATUS_META[item.status]?.classes ?? "bg-muted"
                            }`}
                          >
                            {STATUS_META[item.status]?.label ?? item.status}
                          </Badge>
                        </div>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {new Date(item.created_at).toLocaleDateString()}
                        </span>
                      </div>
                      <Badge variant="outline" className="w-fit font-mono text-[10px] uppercase tracking-wider">
                        {FEEDBACK_CATEGORIES.find((c) => c.value === item.category)?.label ?? item.category}
                      </Badge>
                      <p className="text-sm text-foreground/80 leading-relaxed">{item.message}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </section>

      {/* Quick tips */}
      <section className="space-y-4">
        <h2 className="kpi-label">Quick tips</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TipCard
            icon={<Search className="h-4 w-4 text-accent" />}
            title="Finding leads faster"
            description="Use the Search bar in the pipeline to filter by city, entity name, or owner. Toggle between Candidates, Presale, and Active to focus on the right stage."
          />
          <TipCard
            icon={<AlertCircle className="h-4 w-4 text-warm" />}
            title="Removing bad leads"
            description="Hover over any lead row and click the trash icon to remove it from the pipeline. This keeps your view clean and focused on real opportunities."
          />
          <TipCard
            icon={<Lightbulb className="h-4 w-4 text-emerald-400" />}
            title="Using touchpoints"
            description="Open any lead to see personalized Email, Phone, and LinkedIn outreach scripts. Each message is tailored to the seller's sale details and tax exposure."
          />
          <TipCard
            icon={<Clock className="h-4 w-4 text-muted-foreground" />}
            title="Timing matters"
            description="Leads are sorted by sale date with newest first. The first 45 days after closing are the highest-value window for 1031 outreach."
          />
        </div>
      </section>
    </div>
  );
};

/* ---------- helpers ---------- */

const StepCard = ({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) => (
  <Card className="border-border bg-card">
    <CardContent className="pt-6 space-y-3">
      <div className="h-8 w-8 rounded-md bg-secondary flex items-center justify-center text-accent">{icon}</div>
      <h3 className="font-display text-base">{title}</h3>
      <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
    </CardContent>
  </Card>
);

const StageRow = ({
  stage,
  badge,
  description,
}: {
  stage: string;
  badge: React.ReactNode;
  description: string;
}) => (
  <div className="p-4 flex flex-col md:flex-row md:items-center gap-2 md:gap-6">
    <div className="flex items-center gap-3 min-w-[140px]">
      {badge}
      <span className="font-semibold text-sm">{stage}</span>
    </div>
    <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
  </div>
);

const ChannelCard = ({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) => (
  <div className="border border-border bg-card p-4 space-y-2">
    <div className="flex items-center gap-2 text-accent">{icon}<span className="font-semibold text-sm">{title}</span></div>
    <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
  </div>
);

const TipCard = ({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) => (
  <div className="border border-border bg-card p-4 space-y-2">
    <div className="flex items-center gap-2">{icon}<span className="font-semibold text-sm">{title}</span></div>
    <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
  </div>
);
