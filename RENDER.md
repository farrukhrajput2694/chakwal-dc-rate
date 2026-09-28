# Deploying to Render

The site you get is the site you already run on `127.0.0.1:8765`. This file is the
short version; `README.md` is the long one.

## What gets deployed

Render builds the `Dockerfile` at the repo root. It copies `app.py`, `govapi.py` and
`static/`, installs `requirements.txt`, and serves the page and the API from one process
on one origin. There is no separate frontend host and no separate API host, so there is
no CORS to configure and nothing to rebuild.

```
app.py  govapi.py  static/  requirements.txt  Dockerfile  render.yaml
```

Nothing else is needed. `history.db` is deliberately not in the image (`.dockerignore`
excludes `*.db`); the app creates it on first boot.

## Steps

1. Put the folder in a Git repository:

   ```powershell
   cd C:\Users\Creative Computer\Desktop\Chakwal-DC-Rate-Calculator
   git init
   git add .
   git commit -m "Chakwal DC Rate Calculator"
   ```

   `.gitignore` already excludes `.venv/`, `__pycache__/`, `*.db` and `.env`, so the
   32 MB virtualenv and your local history stay out of the commit.

2. Push it to GitHub (or GitLab):

   ```powershell
   git remote add origin https://github.com/<you>/chakwal-dc-rates.git
   git branch -M main
   git push -u origin main
   ```

3. In Render: **New → Blueprint**, pick the repo, accept the detected `render.yaml`.
   That creates the service, builds the image and gives you a public HTTPS URL.

   Or skip the blueprint and create a **Web Service** by hand: environment *Docker*,
   Dockerfile path `./Dockerfile`.

`render.yaml` sets three things that are load-bearing rather than cosmetic:

| Setting | Why |
|---|---|
| `numInstances: 1` (with `--workers 1` in the Dockerfile) | `BATCH_CONCURRENCY` is a per-process semaphore, so the total process count is what decides how many requests hit the government portal at once. The blueprint caps the container count; the Dockerfile caps uvicorn's workers inside it. Both are needed. |
| `healthCheckPath: /health` | `/health` never calls the portal, so Render's probes cost it nothing. |
| `plan: starter` | The free tier sleeps after inactivity, which is useless for a tool you open on your phone. |

## Do not set these

- `RATE_APP_SERVERLESS=1` — this container keeps one process alive, so the nightly
  refresh, queued bulk runs and SQLite history all work. Setting it switches all three
  off and makes the site behave like the EdgeOne deployment.
- `RATE_APP_REFRESH_HOUR` — the scheduler reads the hour as **Pakistan time** and converts
  to the container's UTC clock internally, so `00:00` is already midnight in Chakwal.
  (An earlier note here suggested `5`. That was wrong: 5 UTC is 10am in Chakwal.)

## First boot takes about six minutes

On a cold start the app walks all 1,070 reference lists (~2,300 calls to the government
portal) before it is useful — that is the same pass your local machine does when it has
been idle overnight, and it measured 361 s here.

This is normal, and it is not a failed deploy:

- The deploy will still report healthy. `/health` answers immediately and reports
  `refresh_running: true` while the pass is in progress.
- The page loads and *looks* correct immediately; a lookup made during the walk will
  fail or hang until it finishes, because the reference lists are what it reads.
- Watch it in the **Logs** tab — the refresh logs its progress. `/api/refresh` shows the
  same state as JSON.

A restart repeats the walk, because a fresh container has no lists in memory and no
memory to keep them in.

## After it is up, check these in order

```powershell
$S = "https://<your-service>.onrender.com"

# 1. Healthy, and the tehsil scope is pinned
(Invoke-RestMethod "$S/health") | ConvertTo-Json

# 2. The reference lists finished loading (wait out the first boot)
(Invoke-RestMethod "$S/health").reference_lists    # a timestamp, or $null

# 3. The page and its assets are the local ones, byte for byte
(Get-FileHash "$S/static/app.js").Hash
(Get-FileHash ".\static\app.js").Hash             # must be identical
```

4. Open the URL and run one lookup in the browser. A known-good one: Mouza **Alawal**,
   Qanoongoee **Balkassar**, classification **Agricultural**, location **Link Road**,
   Khasra **947** → **Rs 366,025 per Acre**.

## If the portal blocks Render

Some government portals reject cloud provider IP ranges. The symptom is specific: the
page loads and looks fine, and every lookup fails with a connection or TLS error, while
`/health` stays green (it never touches the portal). There is no code fix for that — it
needs a host the portal accepts, which is what the VPS and PC-tunnel options in
`README.md` are for.
