import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string = "internal_error"
  ) {
    super(message);
  }
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: "not_found", message: "Resource not found" } });
}

export function createErrorHandler(logger: Logger) {
  // Sanitized error responses: never leak stack traces, provider payloads,
  // or internal file paths to clients.
  return function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
    if (err instanceof ApiError) {
      res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
      return;
    }

    logger.error({ err, path: req.path }, "Unhandled error");
    res.status(500).json({ error: { code: "internal_error", message: "An unexpected error occurred" } });
  };
}
