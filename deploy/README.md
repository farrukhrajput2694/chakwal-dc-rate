# Chakwal DC Rate Calculator — EdgeOne Pages deployment

This folder deploys the calculator to **EdgeOne Pages** so the URL works from
anywhere in the world. The page is not a rewrite: `public/` holds the exact
files the local server serves, byte for byte, so what goes online is what you
were already looking at.

## What is in here

```
public/                      static site — served by EdgeOne's CDN
  index.html                   the page (exact copy)
  static/app.js                the whole client (exact copy)
  static/styles.css            styling (exact copy)
cloud-functions/
  api/[[default]].py           FastAPI entry; owns every /api/* request
  app.py                       the application (exact copy)
  govapi.py                    portal client (exact copy)
  requirements.txt
edgeone.json                  build + function settings
```

`index.html` references `/static/app.js` and `/static/styles.css`, so those two
files sit in a `static/` subfolder. That is why the HTML needs no edits at all.

## Why there is a function in here at all

The rate figures cannot be baked into the page. Every rate is read live from the
Punjab e-Stamp portal on each request and is never written down anywhere. That
portal sends **no CORS headers**, so a browser on any domain cannot read its
replies directly — the request has to be made server-side, by code on the same
site. `cloud-functions/` is that code. Without it the page loads and looks
correct but every lookup fails.

The site is therefore open to the public by default: anyone with the URL can
use the calculator. There is no login, which was a deliberate choice — it means
no credentials to leak and no accounts to manage. It also means anyone can make
the server issue lookups to the government portal. The page warns before any
large run and caps selection size, but those are deterrents, not access control.
If that trade-off stops being right, put authentication in front of the function.

## Deploying

The free plan is **$0/month with no card** and the site is a **direct upload** —
no GitHub account, no repository, no build pipeline. It is a single command.

```powershell
cd "C:\Users\Creative Computer\Desktop\Chakwal-DC-Rate-Calculator\deploy"
& "D:\app\npx.cmd" --yes edgeone makers deploy -n chakwal-dc-rate
```

It prints a URL when it finishes. To update the site later, run the same
command again.

**On Windows, call `npx.cmd`, not `npx`.** The PowerShell execution policy on
this machine blocks the `npx.ps1` shim, and the bare command fails with
"running scripts is disabled on this system". `.cmd` is not affected.

**`npx` may not be on your PATH** even though Node is — Node is installed at
`D:\app` here, which is not a standard location. Use the full path as above.

### Logging in

The first deploy may ask you to sign in (`edgeone login`, opens a browser).
There is also a logged-out path that deploys anonymously and claims the project
afterwards, on CLI 1.6.29 or newer — the current version is 1.6.41:

```powershell
& "D:\app\npx.cmd" --yes edgeone makers deploy --anonymous --json
& "D:\app\npx.cmd" --yes edgeone makers claim --sid <id-from-the-output>
```

### Deploying from Git instead

If you would rather have every push redeploy, the console offers
**Create project → Pages → Connect repo**. Point it at this folder as the
repository root. Both routes deploy the same files; Git is only for automation.

### What the free plan allows

| | Free limit | This app |
|---|---|---|
| Cloud Function executions | 1,000,000 / month | a few hundred |
| Max request duration | 120s (already set) | ~70s worst case |
| Request body | 6 MB | < 1 MB |
| Code package | 128 MB | well under |
| Builds | 500 / month | a handful |

The quota is currently enforced leniently — the docs state the service is not
interrupted for exceeding it and that a ticket can raise it.

A `python = 3.10` runtime is used, so `requirements.txt` pins only floors that
work on 3.10.

### One thing the platform does not let us control

`app.py` caps portal traffic at 4 concurrent requests, but that limiter is
per-process. EdgeOne reuses a warm instance for several requests at once, and
`edgeone.json` exposes no knob for how many — unlike Firebase, where
`concurrency` can be pinned to 1. So the effective cap is
`4 x concurrent-invocations-per-instance`, not 4.

For a small site this is not a practical problem, and the free tier's million
executions a month bounds it. But if you ever put this in front of real
traffic, that cap should be enforced in front of the function (authentication,
or a per-user job queue) rather than trusted from inside it.


## What behaves differently from the local server

Serverless mode is switched on by the entry file. A serverless instance is
created per request and thrown away afterwards, and three things in this app
assume a process that stays alive. All three are off there, and each says so
rather than failing quietly:

| Feature | Local | On EdgeOne | Why |
|---|---|---|---|
| Nightly list refresh | runs at 00:00 | off | No process survives until midnight. Worse, the boot-time staleness check would re-walk all 1,070 lists — ~2,300 portal calls — on *every* cold start. |
| Queued bulk runs | `POST /api/rates/batch/async` | `501` | A job lives in one instance's memory, so the progress poll would be answered by an instance that never heard of it. |
| SQLite history | reads/writes | answers empty | Nothing writes to it any more, and a read-only filesystem should not fail a request. |

Bulk runs still work — they just run synchronously inside one request, capped by
the platform's 120-second limit. The confirmation dialog says so before you
commit to a large selection, because a run the platform cuts off returns nothing
rather than a partial result. In practice the largest Khasra list in the tehsil
(8,768) completes in about 70 seconds.

Reference lists are re-read from the portal on demand instead of overnight, which
is why the footer on the deployed site describes them that way.

## The one thing that cannot be tested from here

Everything above was verified by running this exact code locally in serverless
mode: live lookups, all four scope guards rejecting a run, the 501s, empty
history, 8,768 Khasra chips rendering, a 600-Khasra bulk run completing in 5.4
seconds, and the client correctly choosing the synchronous path. What cannot be
checked without an EdgeOne account is EdgeOne's own routing and build. If the
site loads but `/api/*` 404s, the cause is the `cloud-functions/` path mapping
in step 3, not this code.

## If the portal blocks the function

Some government portals reject cloud provider IP ranges. If every lookup fails
with a connection or TLS error while the page itself works fine, that is what has
happened. There is no workaround in the code — it would need a host the portal
accepts, which is what the `Dockerfile` and `docker-compose.yml` in the project
folder are for.
