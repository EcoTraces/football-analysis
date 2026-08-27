import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "./supabaseClient";
import { getMe } from "./api";
import type { MeProfile } from "./types";

// "not-configured" is a distinct, explicit state (not just "signed-out") —
// this app never pretends auth works when VITE_SUPABASE_URL/ANON_KEY are
// missing, matching the rest of the platform's "no fabricated state"
// convention for missing data providers.
export type AuthStatus = "not-configured" | "loading" | "signed-out" | "signed-in";

interface AuthResult {
  error: string | null;
}

export interface AuthContextValue {
  status: AuthStatus;
  session: Session | null;
  /** The signed-in user's own profile (role, display name) — null until it's loaded, even if signed in. */
  profile: MeProfile | null;
  signInWithPassword: (email: string, password: string) => Promise<AuthResult>;
  signUp: (email: string, password: string) => Promise<AuthResult & { emailConfirmationRequired: boolean }>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>(isSupabaseConfigured ? "loading" : "not-configured");
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<MeProfile | null>(null);

  useEffect(() => {
    if (!supabase) return;

    async function applySession(newSession: Session | null) {
      setSession(newSession);
      setStatus(newSession ? "signed-in" : "signed-out");
      if (!newSession) {
        setProfile(null);
        return;
      }
      try {
        const res = await getMe(newSession.access_token);
        setProfile(res.data);
      } catch {
        // Profile lookup failing shouldn't strand the user on a permanent
        // spinner — they're still signed in, just without role info (so
        // RequireAdmin correctly treats them as non-admin until it resolves).
        setProfile(null);
      }
    }

    supabase.auth.getSession().then(({ data }) => void applySession(data.session));

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      void applySession(newSession);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  async function signInWithPassword(email: string, password: string): Promise<AuthResult> {
    if (!supabase) return { error: "Authentication is not configured on this deployment." };
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  }

  async function signUp(email: string, password: string): Promise<AuthResult & { emailConfirmationRequired: boolean }> {
    if (!supabase) return { error: "Authentication is not configured on this deployment.", emailConfirmationRequired: false };
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return { error: error.message, emailConfirmationRequired: false };
    // No session back means the project requires email confirmation before
    // the account can sign in — not an error, just a different next step.
    return { error: null, emailConfirmationRequired: !data.session };
  }

  async function signOut(): Promise<void> {
    if (!supabase) return;
    await supabase.auth.signOut();
  }

  return (
    <AuthContext.Provider value={{ status, session, profile, signInWithPassword, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
