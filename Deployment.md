# Deployment

**Not yet deployed anywhere.** This document describes how to deploy each
piece once you're ready — do not deploy the admin routes publicly until
`Task.md`'s security items are done (no auth exists on `/api/admin/*` yet).

## Database

Provision a Supabase project. Apply `supabase/migrations/0001_init.sql`
(via `supabase db push` or the SQL editor). Do **not** run
`supabase/seed/dev_seed_synthetic.sql` against a production project — it
exists for local development only.

## Backend (Node/Express)

Containerized via `backend/Dockerfile` (multi-stage build). Deploy to any
container platform (Cloud Run, Render, Railway, Fly.io, etc.). Required
env vars: see `backend/.env.example`. `SUPABASE_SERVICE_ROLE_KEY` must never
reach the frontend or client-side code — it belongs only in this service's
runtime environment.

## ML service (Python/FastAPI)

Containerized via `ml-service/Dockerfile`. Stateless — no database, no
external calls — so it scales horizontally with no special configuration.
Deploy anywhere that runs a container and set `ML_SERVICE_URL` on the
backend to point at it.

## Frontend (React/Vite)

Static build (`npm run build` → `dist/`) servable from any static host
(Vercel, Firebase Hosting, Cloudflare Pages, or the provided
`frontend/Dockerfile` nginx image). Set `VITE_API_BASE_URL` to the deployed
backend's public URL at build time.

## docker-compose (local/staging only)

`docker-compose.yml` at the repo root runs all three services together.
Requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the environment
(or a `.env` file docker compose reads automatically). Not a production
deployment topology on its own — no TLS termination, no restart policy, no
secrets management beyond plain env vars.

## Still missing before a real production deployment

- Auth on admin routes (blocking).
- A CI security-scanning gate (`npm audit`, `pip-audit`) before deploy.
- Actual hosting configuration/IaC for each service.
- A backup/recovery strategy for the Supabase project.
- Monitoring/alerting beyond the basic `/health*` endpoints.
