import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "./testSupabaseFake.js";
import { createRequireAuth } from "../middleware/auth.js";
import { ApiError } from "../middleware/errorHandler.js";

function fakeRequest(authHeader?: string): Request {
  return {
    header: (name: string) => (name.toLowerCase() === "authorization" ? authHeader : undefined)
  } as unknown as Request;
}

describe("requireAuth", () => {
  it("rejects a request with no Authorization header", async () => {
    const fake = new FakeSupabase();
    const middleware = createRequireAuth(fake as unknown as SupabaseClient);
    const next = vi.fn() as unknown as NextFunction;

    await middleware(fakeRequest(), {} as Response, next);

    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(401);
  });

  it("rejects a header that isn't 'Bearer <token>'", async () => {
    const fake = new FakeSupabase();
    const middleware = createRequireAuth(fake as unknown as SupabaseClient);
    const next = vi.fn() as unknown as NextFunction;

    await middleware(fakeRequest("Basic dXNlcjpwYXNz"), {} as Response, next);

    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ApiError;
    expect(err.statusCode).toBe(401);
  });

  it("rejects a token the auth server doesn't recognize", async () => {
    const fake = new FakeSupabase();
    const middleware = createRequireAuth(fake as unknown as SupabaseClient);
    const next = vi.fn() as unknown as NextFunction;

    await middleware(fakeRequest("Bearer not-a-real-token"), {} as Response, next);

    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ApiError;
    expect(err.statusCode).toBe(401);
  });

  it("accepts any valid signed-in user regardless of role, attaching req.authUser", async () => {
    const fake = new FakeSupabase();
    fake.setAuthUser("good-token", "user-1", "user@example.com");
    // Deliberately no user_profiles row and no role check here — that's
    // the whole point of requireAuth vs. requireAdmin.
    const middleware = createRequireAuth(fake as unknown as SupabaseClient);
    const req = fakeRequest("Bearer good-token");
    const next = vi.fn() as unknown as NextFunction;

    await middleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.authUser).toEqual({ id: "user-1", email: "user@example.com" });
  });
});
