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
   - `FOOTBALL_DATA_ORG_API_KEY` — **required**, since `render.yaml`
     defaults `FOOTBALL_DATA_PROVIDER` to `"football-data-org"` (the one
     provider that's actually been exercised against live data — see
     `Changelog.md`'s "First live verification" entry). Get a free key at
     https://www.football-data.org/client/register. Leaving this blank
     makes the service fail fast at boot by design (`registry.ts`) rather
     than silently running with no data — it will NOT deploy successfully
     without this set.
   - `FOOTBALL_DATA_API_KEY` (and optionally `FOOTBALL_DATA_RAPIDAPI_KEY`)
     — leave blank unless you'd rather run api-football instead; if so, get
     a key (see README.md → "Configuring a live football data provider",
     Option A) and switch `FOOTBALL_DATA_PROVIDER` to `"api-football"` in
     the Environment tab. The two providers are swappable alternatives, not
     both-at-once (see `Data_Sources.md`'s "Two providers, never blended").
   - `ML_SERVICE_URL` — leave as `http://localhost:8000` (or blank; that's
     the app's own default) if you haven't deployed `ml-service` anywhere
     yet. `POST /admin/predictions/run` will fail until this points to a
     real, reachable ML service — everything else (fixtures, standings,
     the admin dashboard, sign-in) works without it.
   - `ALLOWED_ORIGINS` — the frontend's deployed URL, once it has one
     (comma-separated if more than one). Leave as `http://localhost:5173`
     for now; this only affects browser-based CORS, not curl/Postman/the
     admin dashboard's own requests to itself.

   `SCHEDULER_ENABLED` defaults to `"true"` in `render.yaml` — this
   Blueprint deploys a single `plan: free` instance with no autoscaling, so
   that's safe as-is (see "Backend (Node/Express)" above for why more than
   one replica with the scheduler on would be wrong). Note Render's
   free-tier spin-down behavior below before relying on it for real
   unattended syncing.
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

**Node version note (found via an actual Render deploy):** the backend
requires **Node 22+** at runtime, not just build time — `backend/Dockerfile`
and `frontend/Dockerfile` are pinned to `node:22-slim` and
`backend/package.json`'s `engines.node` is `>=22`. This isn't an arbitrary
preference: `@supabase/supabase-js`'s `realtime-js` dependency constructs a
`RealtimeClient` (unconditionally, as part of `createClient()`) that
requires the runtime's native `WebSocket` global, which only exists
built-in from Node 22 onward — on Node 20 it throws `Error: Node.js
detected but native WebSocket not found` the instant the app tries to
create its Supabase client, crashing on boot before serving a single
request. This was invisible in every unit test in this repo (they use
`FakeSupabase`, never a real `createClient()` call) and in this
environment's own dev/CI setup (both defaulted to Node 20 without ever
actually booting `dist/index.js` for real) — it only surfaced the first
time this project was actually deployed to a real host. `.github/workflows/ci.yml`
and `README.md`'s stated requirement were updated to Node 22 alongside the
Dockerfiles once this was found, so this doesn't regress silently again.

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

### Deploying the frontend to Vercel

No `vercel.json` exists in this repo — Vercel's own framework detection
(it auto-detects Vite from `frontend/package.json`) is enough, given one
setting below that isn't a default.

1. In the Vercel dashboard: **Add New → Project**, import the
   `EcoTraces/football-analysis` repo (Vercel prompts to connect GitHub
   the first time).
2. **Root Directory must be set to `frontend`** — this is a monorepo with
   three services at the repo root, and Vercel builds from the repo root
   by default, which would fail (no `package.json` there). This is the
   one setting to change; everything else Vercel infers correctly once
   Root Directory is right (Framework Preset: Vite, Build Command:
   `npm run build`, Output Directory: `dist`).
3. Under **Environment Variables**, add the three the frontend needs (see
   `frontend/.env.example`):
   - `VITE_API_BASE_URL` — the deployed backend's public URL plus `/api`,
     e.g. `https://football-analysis-backend.onrender.com/api`
   - `VITE_SUPABASE_URL` — same value as `backend/.env`'s `SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY` — the anon/publishable key, **not** the
     service role key
4. Deploy. Vercel builds and gives you a `*.vercel.app` URL.
5. **Update the backend's `ALLOWED_ORIGINS`** (Render → the backend
   service → Environment tab) to include this Vercel URL — the backend's
   CORS check (`backend/src/index.ts`) rejects requests from any origin
   not in that comma-separated list, so sign-in/API calls from the
   deployed frontend will otherwise fail silently in the browser console
   with a CORS error, not a clear "misconfigured" message. Redeploy the
   backend (or it may pick up the env change on its own, depending on
   Render's settings) after changing it.
6. Confirm end-to-end: open the Vercel URL, sign up, and check the
   Network tab for `200`s against the Render backend rather than CORS
   failures.

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
