# Deployment

**Not yet deployed anywhere.** This document describes how to deploy each
piece once you're ready. `/api/admin/*` and the rest of the app now
require a signed-in user (see README.md → "User access control"), but
that auth has only been tested against a fake Supabase client and briefly
against a running server — not yet against a real Supabase project's
actual JWTs/token lifecycle (`Task.md`). Treat that as unverified, not
absent, before relying on it in production.

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

If `SCHEDULER_ENABLED=true` (the in-process cron scheduler,
`backend/src/scheduler/scheduler.ts` — see `Data_Sources.md`), deploy
exactly **one** instance of this service. The scheduler has no
cross-process locking, so running more than one replica with it enabled
would run every sync job redundantly on each replica rather than once.
Scale horizontally with `SCHEDULER_ENABLED=false` and an external trigger
(e.g. Cloud Scheduler hitting the `/api/admin/*/sync` endpoints) instead,
until the scheduler gets real cross-instance coordination.

### Deploying the backend to Render

`render.yaml` at the repo root is a [Render Blueprint](https://render.com/docs/blueprint-spec)
for exactly this — a Docker web service built from `backend/Dockerfile`,
with `PORT` left for Render to inject (the app already reads
`process.env.PORT`, no code change needed) and every secret marked
`sync: false` so it's never written into this committed file.

**This repo has no Render account connected and nothing has been deployed
by anyone working on it** — the steps below are for you to run yourself,
entirely from a browser (phone or computer both work equally well; a
Render web service, unlike a local `.env` file, only needs a browser to
configure).

1. Push this repo to GitHub if you haven't already (it already is, if
   you're reading this from the repo).
2. In the Render dashboard: **New → Blueprint**, connect the
   `EcoTraces/football-analysis` repo, and Render will detect
   `render.yaml` and propose the `football-analysis-backend` service.
3. Render will prompt you to fill in every `sync: false` variable before
   creating the service:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — from your Supabase
     project's API settings.
   - `FOOTBALL_DATA_API_KEY` — leave blank for now if you don't have one
     yet; the service boots fine with `FOOTBALL_DATA_PROVIDER=null`
     (already set as the default in `render.yaml`) and simply won't sync
     real data until both are set. Set `FOOTBALL_DATA_PROVIDER=api-football`
     in the Environment tab once you add a real key.
   - `ML_SERVICE_URL` — leave as `http://localhost:8000` (or blank; that's
     the app's own default) if you haven't deployed `ml-service` anywhere
     yet. `POST /admin/predictions/run` will fail until this points to a
     real, reachable ML service — everything else (fixtures, standings,
     the admin dashboard, sign-in) works without it.
   - `ALLOWED_ORIGINS` — the frontend's deployed URL, once it has one
     (comma-separated if more than one). Leave as `http://localhost:5173`
     for now; this only affects browser-based CORS, not curl/Postman/the
     admin dashboard's own requests to itself.
4. Deploy. Render builds the Docker image and starts the service; watch
   the build logs in the dashboard (again, works fine from a phone
   browser).
5. Confirm it's actually up: `curl https://<your-service>.onrender.com/api/health`
   should return `{"status":"ok",...}`. Then `GET /api/health/data` and
   `GET /api/health/api-football` to check database/provider status the
   same way the admin dashboard does.
6. Apply the Supabase migrations (see "Database" above) against your
   Supabase project if you haven't yet — the service will boot even
   without them, but every route touching the database will fail until
   the schema exists.
7. Create the first admin account per README.md → "User access control"
   once the service is live, using its real public URL instead of
   `localhost:8080`.

Render's free-tier web services spin down after a period of inactivity
and take a few seconds to wake back up on the next request — expect a
slow first request after idling, not a real outage. This also interacts
with `SCHEDULER_ENABLED=true`: a spun-down instance isn't running its
cron timers, so the scheduler only actually fires while the service is
awake. A paid "always on" plan (or an external uptime ping keeping it
awake) is needed before relying on the scheduler for real automated
syncing on Render's free tier.

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

- Auth exists (see README.md → "User access control") but is unverified
  against a real Supabase project's actual JWTs/token lifecycle — test
  that before relying on it in production, not just in this environment's
  fake-client tests.
- A CI security-scanning gate (`npm audit`, `pip-audit`) before deploy.
- Hosting configuration/IaC for the ML service and frontend — only the
  backend has a concrete deploy target documented (`render.yaml`) so far.
- A backup/recovery strategy for the Supabase project.
- Monitoring/alerting beyond the basic `/health*` endpoints and the admin
  dashboard.
