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
  Building2,
  Globe,
  Sparkles,
  FileSearch,
  Database,
  Workflow,
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

      {/* How the agent works — high level */}
      <section className="space-y-4">
        <h2 className="kpi-label">How the agent works</h2>
        <p className="text-sm text-muted-foreground max-w-3xl leading-relaxed">
          The system runs as a queue of small, focused workers. A nightly scout finds fresh sales, a qualifier scores them,
          and a discovery agent tries <span className="font-semibold text-foreground">one</span> hard pass at finding the
          decision-maker. If contact details surface, the lead lands in <span className="font-semibold text-foreground">Ready to contact</span>.
          If not, it goes to <span className="font-semibold text-foreground">Needs review</span> — the agent does not loop on dead ends.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <StepCard
            icon={<Radar className="h-5 w-5" />}
            title="1. Scout"
            description="Daily 8 AM UTC sweep of enabled county recorders. Pulls fresh deeds, grantor/grantee, sale price, and date."
          />
          <StepCard
            icon={<Target className="h-5 w-5" />}
            title="2. Qualify"
            description="Scores each sale on price, owner type, state tax exposure, and 1031 fit. Cold leads are dropped."
          />
          <StepCard
            icon={<FileSearch className="h-5 w-5" />}
            title="3. Discover"
            description="One multi-source hunt for the decision-maker — entity unmask, person identity, public contact info."
          />
          <StepCard
            icon={<CheckCircle className="h-5 w-5" />}
            title="4. Brief"
            description="Generates the AI brief, outreach angles, and personalized email / phone / LinkedIn scripts."
          />
        </div>
      </section>

      {/* Where the agent looks */}
      <section className="space-y-4">
        <h2 className="kpi-label">Where the agent looks</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SourceCard
            icon={<Building2 className="h-4 w-4" />}
            title="County recorders"
            description="Primary source of truth. Enabled counties across CA, NY, NJ, FL, TX, OR, MA, IL, HI, NV and more. Pulls the raw deed record."
          />
          <SourceCard
            icon={<Database className="h-4 w-4" />}
            title="Entity registries"
            description="OpenCorporates + state Secretary of State filings to unmask the humans behind LLCs and trusts (officers, managers, registered agents)."
          />
          <SourceCard
            icon={<User className="h-4 w-4" />}
            title="Identity sources"
            description="LinkedIn, RocketReach, ZoomInfo, Bizapedia — used to match an owner name to a real person and verified role."
          />
          <SourceCard
            icon={<Globe className="h-4 w-4" />}
            title="Company sites & listings"
            description="Owner's homepage / contact page, plus the original broker or listing page that referenced the property."
          />
          <SourceCard
            icon={<Sparkles className="h-4 w-4" />}
            title="AI grounded search"
            description="Gemini + Google Search to surface public contact info the scrapers missed. Strictly grounded — no invented emails or phones."
          />
          <SourceCard
            icon={<Workflow className="h-4 w-4" />}
            title="Filters & guardrails"
            description="Broker / MLS / listing-agent deny-list (Compass, KW, CBRE, Zillow, LoopNet…) so the agent never returns the listing agent as the seller."
          />
        </div>
      </section>

      {/* Pipeline buckets — match the actual tabs */}
      <section className="space-y-4">
        <h2 className="kpi-label">Pipeline buckets</h2>
        <div className="border border-border bg-card divide-y divide-border">
          <StageRow
            stage="Ready to contact"
            badge={<Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 font-mono text-[10px]">Ready</Badge>}
            description="Verified email, phone, or decision-maker contact found. These are the rows you can act on right now."
          />
          <StageRow
            stage="Needs review"
            badge={<Badge className="bg-urgent text-urgent-foreground font-mono text-[10px]">Review</Badge>}
            description="Discovery couldn't surface contact info on its own. A human takes one look — the agent will not retry."
          />
          <StageRow
            stage="Pre-sale"
            badge={<Badge className="bg-warm text-warm-foreground font-mono text-[10px]">Pre-sale</Badge>}
            description="Listed but not yet sold. Engage BEFORE the 1031 clock starts."
          />
          <StageRow
            stage="All active"
            badge={<Badge className="bg-accent text-accent-foreground font-mono text-[10px]">Active</Badge>}
            description="Every worth-pursuing lead in your pipeline — the catch-all view."
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
