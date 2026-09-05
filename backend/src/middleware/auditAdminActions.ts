import type { NextFunction, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Applied once via router.use() on the admin router, right after
// requireAdmin so req.authUser is already populated — see routes/admin.ts.
// Only mutating requests are recorded (GET routes like /admin/jobs and
// /admin/data-health are reads, not actions to audit).
//
// Writes on res.on("finish") rather than before/around the handler, and
// never awaited: an audit-log failure (e.g. a transient DB blip) must never
// delay or fail the admin action it's recording, or itself become a new
// way for an admin route to break. A write failure is logged, not thrown.
export function createAuditAdminActions(supabase: SupabaseClient, logger: Logger) {
  return function auditAdminActions(req: Request, res: Response, next: NextFunction): void {
    if (!MUTATING_METHODS.has(req.method)) {
      next();
      return;
    }

    res.on("finish", () => {
      void (async () => {
        try {
          const { error } = await supabase.from("admin_audit_log").insert({
            actor_id: req.authUser?.id ?? null,
            actor_email: req.authUser?.email ?? null,
            method: req.method,
            path: req.originalUrl,
            status_code: res.statusCode,
            // Admin request bodies here are config numbers/booleans/ids
            // (weights, thresholds, role strings) — never a secret or
            // credential, so it's safe to store verbatim for the audit
            // trail to actually be useful ("what value did they set this to").
            request_body: req.body && Object.keys(req.body as Record<string, unknown>).length > 0 ? req.body : null
          });
          if (error) logger.error({ err: error, path: req.originalUrl }, "Failed to write admin audit log");
        } catch (err) {
          logger.error({ err, path: req.originalUrl }, "Failed to write admin audit log");
        }
      })();
    });

    next();
  };
}
