# L12

Web app for **AI server cluster testing**: data halls and racks, live GPU
power (MaxLPS / Dynamic Power), InfiniBand fabric, PXE provision and KVM,
and workload / MLPerf-style tests.

```
backend/    FastAPI + SQLAlchemy (Postgres in Docker, SQLite fallback for local dev)
frontend/   Next.js 15 (App Router)
```

## Run locally (no Docker)

Backend — SQLite fallback, seeds demo data and users on first boot:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

Frontend:

```powershell
cd frontend
npm install
npm run dev      # http://localhost:3000
```

On a fresh database the seed creates the administrator
`test@test` / `test`. Sign in with it, then create other accounts from **Users**.
Public self-registration is not exposed.

## Run with Docker (Postgres)

On the PXE host (`karam-e-nil`). Ports are chosen to miss Argus and Libra:

| App | UI | API | DB |
|---|---|---|---|
| Argus | 3000 | 8000 | — |
| L12 | **3333** | **8001** | **5433** |

```bash
cp .env.example .env          # then set JWT_SECRET
sudo docker compose up -d --build  # start (tril is not in the docker group)
sudo docker compose down           # stop (add -v to drop the database)
# UI   http://172.25.231.244:3333   (login: test@test / test)
# API  http://172.25.231.244:8001/docs
# The browser talks only to :3333; Next proxies /api to the API on :8001.
```

Local laptop (no Argus, ports 3000 / 8000):

```bash
docker compose -f docker-compose.dev.yml up --build
```

## Features

- **Cluster** — data halls, rack layout, and live health for the AI server
  floor. Overview gauges cover GPU/CPU draw, memory, and hall power.
- **Dynamic Power (MaxLPS)** — static vs closed-loop rack power allocation.
  Reads GPU watts (Redfish when a PXE hop is connected), writes non-persistent
  setpoints, and clears them on Replay. See `docs/maxlps-redfish-proposal.md`.
- **Network** — InfiniBand / fabric map: switch ports, peers, and live traffic.
- **Provision** — PXE hop, node bring-up, and in-browser KVM consoles.
- **Testing** — catalog of cluster workloads (MLPerf, NCCL, network) to run
  against the racks.
- **Users and settings** — local accounts and roles; Meow / SCC Mode themes.

Interactive API docs: http://localhost:8000/docs (or `:8001` on the PXE host).

## Auth

`AUTH_PROVIDER=local` uses email + password with PBKDF2 hashes and HS256 JWTs.
Public self-registration is disabled; only an authenticated Admin can create
accounts through the Users page or `POST /api/users`. Every protected route
depends on `get_current_user` in `backend/app/security.py`. To move to Entra ID
(or Auth0), validate the OIDC token there and map the `email` claim onto a
`User` row; no route or frontend change is required beyond swapping the login
page for the provider redirect.

## Schema changes

`Base.metadata.create_all` only creates missing tables, so columns added to a
model after the fact are applied on startup by `backend/app/migrations.py` —
an append-only list of `ALTER TABLE … ADD COLUMN` statements that skip anything
already present. Anything beyond adding a defaulted column should move to
Alembic.

## Free public demo deployment

`Dockerfile.render` packages Next.js, FastAPI and nginx into one free Render
web service. The browser uses one origin; nginx sends `/api` and `/uploads` to
FastAPI and everything else to Next.js. Use a free Neon Postgres database so
app data survives Render restarts, and a free Cloudflare R2 (S3-compatible)
bucket so uploaded files survive too.

1. Push this repository to GitHub.
2. Create a free Postgres project at https://neon.com and copy its connection string.
3. Create a free R2 bucket at https://dash.cloudflare.com → **R2**.
4. In https://dashboard.render.com choose **New > Blueprint**, connect the
   repository and select `render.yaml`.
5. Fill `DATABASE_URL`, bootstrap admin credentials, and the S3/R2 values.
6. Deploy, open the generated `onrender.com` URL and sign in with those
   bootstrap credentials. `/api/health` reports `"uploads": "s3"` when object
   storage is wired; `"local"` means files still die on sleep.

Without the S3_* variables the free Render filesystem is ephemeral. The free
service also sleeps when idle, so the first request can take about a minute.

For production, keep object storage, use a production Postgres plan, SSO, and
an always-on service. Set a custom domain and terminate HTTPS at the hosting
platform.
