## What's actually happening

**Sources tab redirects to Outreach after a flash.** Root cause is in `src/hooks/useAuth.tsx`:

```ts
supabase.auth.getSession().then(({ data }) => {
  setSession(...); setUser(...);
  if (data.session?.user) loadRoles(data.session.user.id); // async, not awaited
  setLoading(false);                                       // flips immediately
});
```

`loading` flips to `false` before `loadRoles` finishes, so for one render `roles=[]` → `isAdmin=false`. `Admin.tsx` then runs `if (!isAdmin) return <Navigate to="/outreach" />` and kicks you out. Your user (`yorgho@youdeciderealty.com`) is confirmed `admin` in `user_roles`, so it's purely a timing bug.

**Connections audit:** only **Firecrawl** is linked to this project. Perplexity, ElevenLabs, Resend, Twilio, and Search Console are visible in the workspace but not linked here, so there's nothing to disconnect. No connector is causing the failure.

**Stale deployed function:** legacy `draft-outreach` is already removed from the codebase and from every caller (`job-dispatcher`, `seller-discovery`, `LeadDrawer`, `PipelineHealthCard` are clean), but the *deployed* copy on Lovable Cloud is still there and needs to be removed.

## Changes

1. **`src/hooks/useAuth.tsx`** — await roles before clearing `loading`.
   - In the `getSession().then(...)` branch: `await loadRoles(...)` before `setLoading(false)`, so `isAdmin` is correct on the very first render.
   - In `onAuthStateChange`: same idea — when a user is present, set a transient loading flag while roles fetch, then clear. Sign-out path stays instant.
   - Net effect: `Admin.tsx`'s `if (loading) return null` actually waits for roles, so the redirect can't fire on a stale `isAdmin=false`.

2. **Delete the deployed `draft-outreach` edge function** via `supabase--delete_edge_functions(["draft-outreach"])`. No code changes needed — it's already gone from the repo.

That's it. No other functions, connections, or DB changes touched (you asked to leave functions alone otherwise).

## Verification

- Reload `/admin` while signed in as `yorgho@…` → page stays on Sources, doesn't bounce.
- Reload `/admin` while signed out → still redirects to `/auth` (unchanged).
- `supabase functions list` no longer shows `draft-outreach`.
