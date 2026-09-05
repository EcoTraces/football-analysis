import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import pino from "pino";
import { FakeSupabase } from "./testSupabaseFake.js";
import { createAuditAdminActions } from "../middleware/auditAdminActions.js";

const silentLogger = pino({ level: "silent" });

function fakeRequest(overrides: Partial<Request> = {}): Request {
  return {
    method: "POST",
    originalUrl: "/api/admin/config/ensemble-weights",
    body: {},
    authUser: undefined,
    ...overrides
  } as unknown as Request;
}

// res.on("finish", ...) is how the middleware defers its write until after
// the response is sent — this fake captures the listener so the test can
// fire it manually, the same way Express would once the real response ends.
function fakeResponse(statusCode = 200): { res: Response; fireFinish: () => void } {
  let finishListener: (() => void) | null = null;
  const res = {
    statusCode,
    on: (event: string, cb: () => void) => {
      if (event === "finish") finishListener = cb;
    }
  } as unknown as Response;
  return { res, fireFinish: () => finishListener?.() };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createAuditAdminActions", () => {
  it("does not touch admin_audit_log for a read (GET) request", async () => {
    const fake = new FakeSupabase();
    const middleware = createAuditAdminActions(fake as unknown as SupabaseClient, silentLogger);
    const next = vi.fn() as unknown as NextFunction;
    const { res, fireFinish } = fakeResponse(200);

    middleware(fakeRequest({ method: "GET" }), res, next);
    fireFinish();
    await flushMicrotasks();

    expect(next).toHaveBeenCalledTimes(1);
    expect(fake.rows("admin_audit_log")).toHaveLength(0);
  });

  it("records a mutating request's actor, method, path, status, and body once the response finishes", async () => {
    const fake = new FakeSupabase();
    const middleware = createAuditAdminActions(fake as unknown as SupabaseClient, silentLogger);
    const next = vi.fn() as unknown as NextFunction;
    const { res, fireFinish } = fakeResponse(200);

    middleware(
      fakeRequest({
        method: "PUT",
        originalUrl: "/api/admin/config/ensemble-weights",
        body: { eloWeight: 0.3 },
        authUser: { id: "admin-1", email: "admin@example.com" }
      }),
      res,
      next
    );
    // The middleware itself calls next() synchronously, before the response
    // (and therefore the audit write) happens — same as requireAdmin.
    expect(next).toHaveBeenCalledTimes(1);
    expect(fake.rows("admin_audit_log")).toHaveLength(0);

    fireFinish();
    await flushMicrotasks();

    const rows = fake.rows("admin_audit_log");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: "admin-1",
      actor_email: "admin@example.com",
      method: "PUT",
      path: "/api/admin/config/ensemble-weights",
      status_code: 200,
      request_body: { eloWeight: 0.3 }
    });
  });

  it("still records the action when the admin route itself returned an error status", async () => {
    const fake = new FakeSupabase();
    const middleware = createAuditAdminActions(fake as unknown as SupabaseClient, silentLogger);
    const next = vi.fn() as unknown as NextFunction;
    const { res, fireFinish } = fakeResponse(409);

    middleware(fakeRequest({ method: "POST", authUser: { id: "admin-1", email: null } }), res, next);
    fireFinish();
    await flushMicrotasks();

    expect(fake.rows("admin_audit_log")[0]).toMatchObject({ status_code: 409 });
  });

  it("stores no body (null) for a mutating request with an empty body, e.g. a bare POST /admin/sync trigger", async () => {
    const fake = new FakeSupabase();
    const middleware = createAuditAdminActions(fake as unknown as SupabaseClient, silentLogger);
    const next = vi.fn() as unknown as NextFunction;
    const { res, fireFinish } = fakeResponse(200);

    middleware(fakeRequest({ method: "POST", body: {}, authUser: { id: "admin-1", email: null } }), res, next);
    fireFinish();
    await flushMicrotasks();

    expect(fake.rows("admin_audit_log")[0]?.request_body).toBeNull();
  });

  it("records null actor fields for a request with no authUser rather than throwing", async () => {
    const fake = new FakeSupabase();
    const middleware = createAuditAdminActions(fake as unknown as SupabaseClient, silentLogger);
    const next = vi.fn() as unknown as NextFunction;
    const { res, fireFinish } = fakeResponse(200);

    middleware(fakeRequest({ method: "DELETE", authUser: undefined }), res, next);
    fireFinish();
    await flushMicrotasks();

    expect(fake.rows("admin_audit_log")[0]).toMatchObject({ actor_id: null, actor_email: null });
  });

  it("logs, but does not throw, when the audit write itself fails", async () => {
    const fake = new FakeSupabase();
    fake.failNextInsert("admin_audit_log");
    const errorSpy = vi.spyOn(silentLogger, "error");
    const middleware = createAuditAdminActions(fake as unknown as SupabaseClient, silentLogger);
    const next = vi.fn() as unknown as NextFunction;
    const { res, fireFinish } = fakeResponse(200);

    expect(() => {
      middleware(fakeRequest({ method: "POST", authUser: { id: "admin-1", email: null } }), res, next);
      fireFinish();
    }).not.toThrow();
    await flushMicrotasks();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
