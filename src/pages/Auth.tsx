import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";

const Auth = () => {
  const nav = useNavigate();
  const { user, loading } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user) nav("/outreach", { replace: true });
  }, [user, loading, nav]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email, password,
          options: {
            emailRedirectTo: `${window.location.origin}/outreach`,
            data: { display_name: name || email.split("@")[0] },
          },
        });
        if (error) throw error;
        toast.success("Check your email to confirm your account.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        nav("/outreach");
      }
    } catch (err: any) {
      toast.error(err.message ?? "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex">
      <div className="hidden lg:flex flex-col justify-between w-1/2 p-12 bg-primary text-primary-foreground" style={{ background: "var(--gradient-ink)" }}>
        <div className="font-mono text-xs uppercase tracking-[0.3em] text-accent">1031 / Intelligence Desk</div>
        <div>
          <h1 className="font-display text-6xl leading-[0.95]">
            Find the seller<br />before the<br /><span className="text-accent italic">45-day clock</span> runs out.
          </h1>
          <p className="mt-6 max-w-md text-sm text-primary-foreground/70 leading-relaxed">
            An autonomous agent that scans public deed records across high-tax states,
            qualifies high-net-worth sellers in real time, and drafts the first outreach
            for every lead. Las Vegas, ready.
          </p>
        </div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-primary-foreground/40">
          Confidential · For licensed intermediaries
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-2">
            {mode === "signin" ? "Member access" : "New member"}
          </div>
          <h2 className="font-display text-4xl mb-8">
            {mode === "signin" ? "Sign in." : "Create account."}
          </h2>
          <form onSubmit={submit} className="space-y-4">
            {mode === "signup" && (
              <div>
                <Label className="text-xs font-mono uppercase tracking-wider">Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} className="rounded-none border-0 border-b-2 border-foreground bg-transparent px-0 focus-visible:ring-0 focus-visible:border-accent" />
              </div>
            )}
            <div>
              <Label className="text-xs font-mono uppercase tracking-wider">Email</Label>
              <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-none border-0 border-b-2 border-foreground bg-transparent px-0 focus-visible:ring-0 focus-visible:border-accent" />
            </div>
            <div>
              <Label className="text-xs font-mono uppercase tracking-wider">Password</Label>
              <Input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} className="rounded-none border-0 border-b-2 border-foreground bg-transparent px-0 focus-visible:ring-0 focus-visible:border-accent" />
            </div>
            <Button type="submit" disabled={busy} className="w-full rounded-none bg-accent text-accent-foreground hover:bg-accent/90 font-mono uppercase tracking-wider text-xs h-12">
              {busy ? "..." : mode === "signin" ? "Enter" : "Create"}
            </Button>
          </form>
          <button onClick={() => setMode(mode === "signin" ? "signup" : "signin")} className="mt-6 text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-accent">
            {mode === "signin" ? "→ Create account" : "→ Have an account? Sign in"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Auth;
