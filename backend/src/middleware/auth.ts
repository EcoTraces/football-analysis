import type { NextFunction, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "./errorHandler.js";

const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

export interface AuthenticatedUser {
  id: string;
  email: string | null;
}

declare module "express-serve-static-core" {
  interface Request {
    /** Set by requireAuth/requireAdmin once the bearer token has been verified. */
    authUser?: AuthenticatedUser;
  }
}

// Verifies a Supabase-issued user JWT via the Auth server (auth.getUser()
// works regardless of the project's signing algorithm/key rotation, unlike
// verifying the JWT locally against a static secret). Shared by
// requireAuth (any signed-in user) and requireAdmin (signed-in + admin
// role, requireAdmin.ts) so the token-verification logic lives in exactly
// one place instead of being duplicated between them.
export async function getAuthenticatedUser(supabase: SupabaseClient, req: Request): Promise<AuthenticatedUser> {
  const authHeader = req.header("authorization");
  const token = authHeader ? BEARER_PATTERN.exec(authHeader)?.[1] : undefined;
  if (!token) {
    throw new ApiError(401, "Missing or malformed Authorization header (expected 'Bearer <token>')", "unauthenticated");
  }

  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) {
    throw new ApiError(401, "Invalid or expired token", "unauthenticated");
  }

  return { id: authData.user.id, email: authData.user.email ?? null };
}

// Any signed-in user — no role check. Attaches the verified user to
// req.authUser for downstream handlers (e.g. GET /me).
export function createRequireAuth(supabase: SupabaseClient) {
  return async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      req.authUser = await getAuthenticatedUser(supabase, req);
      next();
    } catch (err) {
      next(err);
    }
  };
}
