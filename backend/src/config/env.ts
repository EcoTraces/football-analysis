import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ML_SERVICE_URL: z.string().url().default("http://localhost:8000"),
  // "football-data-org" is a SWAPPABLE ALTERNATIVE to api-football, not a
  // second simultaneous source — see Data_Sources.md and
  // FootballDataOrgProvider.ts's module comment for why this platform only
  // ever runs one FootballDataProvider at a time.
  FOOTBALL_DATA_PROVIDER: z.enum(["null", "api-football", "football-data-org"]).default("null"),
  FOOTBALL_DATA_API_KEY: z.string().optional().default(""),
  // Optional backup credential for the SAME vendor (API-Football), accessed
  // via RapidAPI instead of the direct api-sports.io channel — a separate
  // subscription/quota pool, used only as a failover when the primary
  // channel fails (see ApiFootballProvider.ts). Empty by default, meaning
  // "no backup configured" — the provider then behaves exactly as it did
  // before this option existed. Only meaningful when
  // FOOTBALL_DATA_PROVIDER=api-football.
  FOOTBALL_DATA_RAPIDAPI_KEY: z.string().optional().default(""),
  // Required (fails fast at boot, same pattern as FOOTBALL_DATA_API_KEY)
  // when FOOTBALL_DATA_PROVIDER=football-data-org — see
  // FootballDataOrgProvider.ts.
  FOOTBALL_DATA_ORG_API_KEY: z.string().optional().default(""),
  SCHEDULER_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  ODDS_API_KEY: z.string().optional().default(""),
  WEATHER_API_KEY: z.string().optional().default(""),
  ALLOWED_ORIGINS: z.string().default("http://localhost:5173"),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().default(120)
});

export type Env = z.infer<typeof envSchema>;

// Parsed once at boot. A missing/invalid required var must fail fast rather
// than let the service run half-configured against a database it can't see.
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}
