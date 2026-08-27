import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createRequireAuth } from "../middleware/auth.js";

export interface UserProfileRow {
  id: string;
  display_name: string | null;
  role: string;
  created_at: string;
}

// Auto-provisions the caller's own user_profiles row on first call via
// upsert (role defaults to 'user' at the column level) rather than
// requiring a separate signup step or a client-side insert racing this
// read — the backend, using the service role, is the single place this
// row gets created either way (see supabase/migrations/0004's comment on
// why role changes are restricted to the service role). Exported (and
// framework-agnostic) for direct unit testing.
export async function getOrCreateProfile(supabase: SupabaseClient, userId: string): Promise<UserProfileRow> {
  const { error: upsertError } = await supabase.from("user_profiles").upsert({ id: userId }, { onConflict: "id" });
  if (upsertError) throw new Error(`Failed to provision user_profiles row: ${upsertError.message}`);

  const { data: profile, error } = await supabase
    .from("user_profiles")
    .select("id, display_name, role, created_at")
    .eq("id", userId)
    .single<UserProfileRow>();
  if (error) throw new Error(`Failed to load user_profiles: ${error.message}`);
  return profile;
}

// Any signed-in user (not admin-gated) — used by the frontend right after
// sign-in to find out who it's talking to and whether to show admin UI.
export function createMeRouter(supabase: SupabaseClient): Router {
  const router = Router();

  router.get("/me", createRequireAuth(supabase), async (req, res, next) => {
    try {
      const profile = await getOrCreateProfile(supabase, req.authUser!.id);
      res.json({
        data: {
          id: profile.id,
          email: req.authUser!.email,
          displayName: profile.display_name,
          role: profile.role,
          createdAt: profile.created_at
        }
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
