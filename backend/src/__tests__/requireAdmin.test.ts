import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "./testSupabaseFake.js";
import { createRequireAdmin } from "../middleware/requireAdmin.js";
import { ApiError } from "../middleware/errorHandler.js";

function fakeRequest(authHeader?: string): Request {
  return {
    header: (name: string) => (name.toLowerCase() === "authorization" ? authHeader : undefined)
  } as unknown as Request;
}

describe("requireAdmin", () => {
  it("rejects a request with no Authorization header", async () => {
    const fake = new FakeSupabase();
    const middleware = createRequireAdmin(fake as unknown as SupabaseClient);
    const next = vi.fn() as unknown as NextFunction;

    await middleware(fakeRequest(), {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(401);
  });

  it("rejects a header that isn't 'Bearer <token>'", async () => {
    const fake = new FakeSupabase();
    const middleware = createRequireAdmin(fake as unknown as SupabaseClient);
    const next = vi.fn() as unknown as NextFunction;

    await middleware(fakeRequest("Basic dXNlcjpwYXNz"), {} as Response, next);

    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ApiError;
    expect(err.statusCode).toBe(401);
  });

  it("rejects a token the auth server doesn't recognize", async () => {
    const fake = new FakeSupabase();
    const middleware = createRequireAdmin(fake as unknown as SupabaseClient);
    const next = vi.fn() as unknown as NextFunction;

    await middleware(fakeRequest("Bearer not-a-real-token"), {} as Response, next);

    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ApiError;
    expect(err.statusCode).toBe(401);
  });

  it("rejects a valid, authenticated user with no admin role", async () => {
    const fake = new FakeSupabase();
    fake.setAuthUser("good-token", "user-1");
    fake.seed("user_profiles", [{ id: "user-1", role: "user" }]);
    const middleware = createRequireAdmin(fake as unknown as SupabaseClient);
    const next = vi.fn() as unknown as NextFunction;

    await middleware(fakeRequest("Bearer good-token"), {} as Response, next);

    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ApiError;
    expect(err.statusCode).toBe(403);
  });

  it("rejects a valid, authenticated user with no user_profiles row at all", async () => {
    const fake = new FakeSupabase();
    fake.setAuthUser("good-token", "user-without-profile");
    const middleware = createRequireAdmin(fake as unknown as SupabaseClient);
    const next = vi.fn() as unknown as NextFunction;

    await middleware(fakeRequest("Bearer good-token"), {} as Response, next);

    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ApiError;
    expect(err.statusCode).toBe(403);
  });

  it("calls next() with no error for a valid admin user", async () => {
    const fake = new FakeSupabase();
    fake.setAuthUser("admin-token", "admin-1");
    fake.seed("user_profiles", [{ id: "admin-1", role: "admin" }]);
    const middleware = createRequireAdmin(fake as unknown as SupabaseClient);
    const next = vi.fn() as unknown as NextFunction;

    await middleware(fakeRequest("Bearer admin-token"), {} as Response, next);

    expect(next).toHaveBeenCalledWith();
  });
});
