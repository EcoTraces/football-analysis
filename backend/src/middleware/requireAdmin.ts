import type { NextFunction, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "./errorHandler.js";
import { getAuthenticatedUser } from "./auth.js";

// Verifies a Supabase-issued user JWT (see auth.ts's getAuthenticatedUser)
// and requires user_profiles.role = 'admin' for the underlying user. See
// README.md → "User access control" for how an operator gets this role
// today, and
// routes/admin.ts's GET/POST /admin/users for the in-app way an existing
// admin promotes someone else.
//
// Applied to the whole admin router (`router.use(...)`), not per-route —
// every /api/admin/* endpoint must be behind this, and a route added later
// without this middleware would otherwise ship unauthenticated by omission.
export function createRequireAdmin(supabase: SupabaseClient) {
  return async function requireAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await getAuthenticatedUser(supabase, req);

      const { data: profile, error: profileError } = await supabase
        .from("user_profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      if (profileError) {
        throw new Error(`Failed to look up user_profiles for admin check: ${profileError.message}`);
      }
      if (!profile || profile.role !== "admin") {
        throw new ApiError(403, "This action requires an admin account", "forbidden");
      }

      req.authUser = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}
