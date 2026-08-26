import type { NextFunction, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "./errorHandler.js";

const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

// Verifies a Supabase-issued user JWT (via the Auth server — auth.getUser()
// works regardless of the project's signing algorithm/key rotation, unlike
// verifying the JWT locally against a static secret) and requires
// user_profiles.role = 'admin' for the underlying user. There is no signup/
// role-assignment UI yet; see README.md → "Creating the first admin user"
// for how an operator gets this role today.
//
// Applied to the whole admin router (`router.use(...)`), not per-route —
// every /api/admin/* endpoint must be behind this, and a route added later
// without this middleware would otherwise ship unauthenticated by omission.
export function createRequireAdmin(supabase: SupabaseClient) {
  return async function requireAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const authHeader = req.header("authorization");
      const token = authHeader ? BEARER_PATTERN.exec(authHeader)?.[1] : undefined;
      if (!token) {
        throw new ApiError(401, "Missing or malformed Authorization header (expected 'Bearer <token>')", "unauthenticated");
      }

      const { data: authData, error: authError } = await supabase.auth.getUser(token);
      if (authError || !authData?.user) {
        throw new ApiError(401, "Invalid or expired token", "unauthenticated");
      }

      const { data: profile, error: profileError } = await supabase
        .from("user_profiles")
        .select("role")
        .eq("id", authData.user.id)
        .maybeSingle();
      if (profileError) {
        throw new Error(`Failed to look up user_profiles for admin check: ${profileError.message}`);
      }
      if (!profile || profile.role !== "admin") {
        throw new ApiError(403, "This action requires an admin account", "forbidden");
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
