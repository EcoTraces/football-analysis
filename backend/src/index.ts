import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pino from "pino";
import { pinoHttp } from "pino-http";

import { loadEnv } from "./config/env.js";
import { createSupabaseClient } from "./lib/supabaseClient.js";
import { createProvider } from "./providers/registry.js";
import { createHealthRouter } from "./routes/health.js";
import { createFixturesRouter } from "./routes/fixtures.js";
import { createMatchesRouter } from "./routes/matches.js";
import { createTeamsRouter } from "./routes/teams.js";
import { createCompetitionsRouter } from "./routes/competitions.js";
import { createAdminRouter } from "./routes/admin.js";
import { createErrorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { startScheduler } from "./scheduler/scheduler.js";

const env = loadEnv();
const logger = pino({ level: env.NODE_ENV === "production" ? "info" : "debug" });
const supabase = createSupabaseClient(env);
const provider = createProvider(env);

const app = express();
app.use(helmet());
app.use(
  cors({
    origin: env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()),
    credentials: true
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(pinoHttp({ logger }));
app.use(
  rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.use("/api", createHealthRouter(supabase, provider));
app.use("/api", createFixturesRouter(supabase));
app.use("/api", createMatchesRouter(supabase));
app.use("/api", createTeamsRouter(supabase));
app.use("/api", createCompetitionsRouter(supabase));
app.use("/api", createAdminRouter(supabase, provider, env.ML_SERVICE_URL, logger));

app.use(notFoundHandler);
app.use(createErrorHandler(logger));

const server = app.listen(env.PORT, () => {
  logger.info(`Backend listening on port ${env.PORT} (provider=${provider.name})`);
});

const scheduler = env.SCHEDULER_ENABLED
  ? startScheduler({ supabase, provider, mlServiceUrl: env.ML_SERVICE_URL, logger })
  : null;
if (!scheduler) {
  logger.info("Scheduler disabled (SCHEDULER_ENABLED=false) — sync/prediction jobs run only via POST /api/admin/*.");
}

function shutdown(signal: string): void {
  logger.info(`${signal} received, shutting down`);
  scheduler?.stop();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
