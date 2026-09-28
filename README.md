# Chakwal DC Rate Calculator

A small local tool for looking up **Tehsil Chakwal** land rates on the Punjab
**District Collector (DC)** valuation list, without clicking through the official
portal's seven-level form every time.

**This is not a government website.** It is an unofficial, read-only convenience helper
that reads public rate lookups from the official e-Stamping portal. It is not affiliated
with or endorsed by the Government of the Punjab, the Board of Revenue, or PLRA, it uses
no government branding or logos, and it deliberately has no affiliation with any
official domain. Rates are fetched live from the official portal at request time — this
tool never authors, stores, or publishes a rate of its own.

> Confirm anything legally binding — challans, stamp duty, registration, a deed — on the
> official portal itself. This tool exists only to save you time finding a number.

---

## Scope: Tehsil Chakwal only

This build is pinned to **Tehsil Chakwal, District Chakwal** (portal district id `21`,
tehsil id `75`). The district and tehsil dropdowns are gone — both render as fixed
labels — and the API refuses any request naming a different district or tehsil rather
than quietly serving someone else's rates.

To retarget it, change four constants at the top of `app.py` and restart:

```python
DISTRICT_ID = 21
DISTRICT_NAME = "Chakwal"
TEHSIL_ID = 75
TEHSIL_NAME = "Chakwal"
```

`govapi.py` itself is district- and tehsil-agnostic and still works for any Punjab
district or tehsil.

## What it does

- **Both land types, both kept.** Rural (`Mouza → Classification → Location → Khasra`) and
  urban (`Town → Revenue Circle → Floor → Property Area → …`), behind a Rural/Urban toggle.
- **Pick the Mouza, skip the Qanoongoee.** All 226 mouzas of the tehsil sit in one
  dropdown, grouped by Qanoongoee, and choosing a mouza fills the Qanoongoee in for you.
  Narrow the list by picking a Qanoongoee first if you prefer. The two can never disagree.
- **Search the mouza list by name.** Type into the box above the Mouza dropdown to filter
  it live, and the count updates. See [Searching mouzas](#searching-mouzas).
- **Tells you which identifier matters.** The official form makes you guess whether a
  parcel is rated by Khasra, by Square/Qila, or at Property Area level. This tool asks
  the portal and shows only the relevant inputs.
- **Correct rate units.** Tehsil Chakwal's rural agricultural Khasras are quoted **per
  Acre**, not per Marla. The tool handles the conversion rather than assuming Marla.
- **No rate to type in.** The DC rate is read from the official portal automatically once
  you have picked the parcel, and it is shown read-only. There is no rate box and no button,
  because a hand-keyed figure cannot be traced back to a published DC Valuation row — and a
  number that looks authoritative but was typed in is the failure this tool exists to
  prevent. The result is the **value of the Khasra**, with the rate shown as the basis it
  is worked out from.
- **Bulk Khasra lookup.** Pick many Khasras of one mouza — click them, or Shift-click a
  range — and each one is looked up individually, so every row carries its own rate, its own
  unit and its own value. Downloadable as CSV. See
  [Bulk lookups](#bulk-lookups-many-khasras-at-once).
- **Built-in area calculator.** Acre / Kanal / Marla / sq ft, using the official portal's
  own conversion constants and its selectable variants.

## What this build deliberately does not do

- **No saved history, no link card.** Earlier versions had a "Saved lookups" table with a
  local SQLite store and a grid of official-portal links. Both were removed. Nothing is
  written to `history.db` any more — the batch CSV is the only export. The backend
  `/api/history*` routes still exist but nothing calls them, so restoring either feature is
  a matter of re-adding markup.

## How fresh the data is

Two different things are fetched from the portal, and they are treated very differently.

### Rates are never stored, and never refreshed in advance

Every rate comes from `MouzaRateByLandInfo` on the request that needs it. Nothing is
written to disk, and the only thing the 5-minute rate cache does is collapse a repeat
lookup of the *same* Khasra. So a rate can never be stale by more than that, and
restarting the app loses nothing.

**Rates are deliberately not pre-fetched on a schedule.** The tehsil contains **916,700**
distinct Khasra rates. Holding them all would mean one full pass taking **~117 minutes of
continuous requests** to a government server, and keeping them current would mean
repeating that constantly — tens of hours of load every day. There is no version of
"auto-update all rates" that is not a denial-of-service on a public service, so this one
does not exist. If a rate is wrong, the fix belongs at the portal, not in a cache here.

### The reference lists are refreshed every night at midnight

The *lists* — 8 Qanoongoes, 226 mouzas, and 1,070 classification/location combinations
with their Khasra numbers, **916,700 Khasras in total** — are a different matter. They
change rarely, and they are what you actually notice going stale: a Khasra the portal
adds shows up as a chip that isn't there.

A background job re-walks and re-seeds all of them at **00:00 local time, daily**. It
bypasses the cache rather than re-seeding it, so a genuinely new Khasra is picked up
rather than yesterday's list being copied forward. Measured cost of a full pass:

| | |
|---|---:|
| Lists re-read | 1,070 |
| Khasras covered | 916,700 |
| Failures | 0 |
| **Duration** | **~5.7 minutes** |

That is roughly 2,300 list calls, about 7 per second — light traffic, once a day, and
never on the rate endpoints.

**The schedule is a background loop in `lifespan`, not a cron job.** It needs the app to
be running at midnight; if the machine was off, the next launch notices the last good
pass is over a day old and refreshes immediately. The footer shows the last result, the
next run time, and a **Refresh lists now** button. A failed pass is reported in the
footer in the warning colour rather than being swallowed, and it does not overwrite the
last known-good timestamp or disturb the lists already in use.

Configure with `REFRESH_HOUR` / `REFRESH_MINUTE` in `app.py` (0, 0 = midnight). These are a
wall-clock time in **Pakistan time**, not the host's local time, and the scheduler converts to
the host's own clock internally. A hosted container runs on UTC, where a naive
`datetime.now()` would make "midnight" land at 5am in Chakwal; anchoring the schedule on
`PAKISTAN_TZ` (a fixed UTC+5, no DST) means 00:00 means midnight in Chakwal on a Pakistan
laptop and on a Render container alike, with no per-host environment variable. The footer
reports the next run on the same Pakistan clock, so it reads identically on both.

> An earlier version of this file said to set `RATE_APP_REFRESH_HOUR=5` on a UTC host. That
> was wrong — 5 UTC is 10am in Chakwal, and midnight in Chakwal is 19 UTC. The scheduler now
> carries the zone itself, so the variable is only for changing the hour.

### When a refresh is running, you come first

The refresh and your lookups share one concurrency ceiling, so the portal never sees more
than `BATCH_CONCURRENCY` requests in flight regardless of what else is happening. The
catch is that a plain semaphore is not good enough: the refresh parks ~2,300 list reads on
the same queue your bulk run uses, and with FIFO ordering an 8,768-Khasra run sat behind
all of them and looked hung.

So `_PriorityLimiter` in `app.py` makes background work stand aside whenever a user is
waiting. The refresh can be delayed by a long bulk run, which is the right way round.

It also hands a freed slot to exactly **one** waiter instead of broadcasting. That sounds
like a micro-optimisation and is not: an 8,768-Khasra run parks 8,768 coroutines, so
broadcasting on each release means every one of ~8,768 releases wakes all 8,768 waiters.
That is tens of millions of pointless wakeups, and it starves the event loop badly enough
that the progress endpoint stops answering — 3,000 Khasras took **69.7 s** that way. With a
targeted handoff the same run takes **24.8 s** and polls respond in 1–11 ms.

Measured, 200 Khasras:

| | Rate |
|---|---:|
| No refresh running | ~134/sec |
| Refresh running | ~70/sec |

The refresh only borrows the slots you are not using, and only for the ~5 minutes it now
takes. If you never notice a difference, that is the intent.

## Searching mouzas

The Mouza dropdown holds all 226 mouzas of the tehsil grouped by Qanoongoee, so the box
above it filters that list as you type. Filtering runs against the copy already in memory
and costs no portal traffic however fast you type.

It reports what it did, because a disabled dropdown with no explanation reads as a broken
page:

| Typed | Result |
|---|---|
| `khan` | 4 matches across 3 Qanoongoes — *Mohra Sheikhan*, *Jand Khanzada*, *Khan Pur*, *Khanwal* |
| `khan pur` | 1 match — *Khan Pur* |
| `zzzz` | No matches; the dropdown disables and says *"No mouza matches “zzzz”. Try a shorter spelling."* |

Matching is a case-insensitive substring, so `khan` finds both *Khan Pur* and *Khanwal*.

**How a search interacts with the Qanoongoee.** The two are coupled — a mouza pick
auto-fills and locks its Qanoongoee — so a search has to decide what to do about a lock it
did not ask for:

- **A Qanoongoee you chose yourself is respected.** Pick *Neela*, then type `i`, and the
  search narrows within Neela's 23.
- **A Qanoongoee that was auto-set is released.** If the last mouza pick locked the list to
  one Qanoongoee, typing a search means you are after something else, so the search is
  allowed to see the whole tehsil. Without this, searching for a mouza you know is
  elsewhere would silently return nothing.

Once a mouza is chosen the search box clears and the list re-lays under the Qanoongoee that
now owns the choice, so the dropdown and the lock always agree.

## Bulk lookups: many Khasras at once

Choose a rural chain down to a **Location**, then click **Select many Khasras…**. A
searchable grid of the Khasras in that exact mouza / classification / location appears;
click chips to toggle them, use *Select all matching*, or use the filter box. The run reports
a sortable table (`Khasra · Area · DC rate · Value of Khasra`), a summary, and a CSV
download.

**Every Khasra gets its own rate and its own value.** Each is looked up separately, so the
table can show you that two Khasras in the same location are rated differently — or that
one is quoted per Marla and the other per Acre, which differ by a factor of 160. The
summary counts the distinct rates, and says so plainly when a selection does not share
one. A Khasra the portal publishes no rate for keeps its area, leaves its value blank
rather than printing a zero, and is counted separately.

**The numbers are in ascending order, and Shift-click selects a run.** The portal returns
Khasras in no useful order — Alawal's first twenty come back as 3785, 4071, 4073, 3120,
855, 20 — so the grid sorts them itself. Comparison is numeric, not textual, which matters
twice over: text sort puts `20` after `1998` and `10` before `9`. Almost all values are
plain integers (37,797 in a 37,806 sample across 42 mouza/location lists), but a handful
carry a subdivision — `1807/1`, `2047/55`, `824/43` — and each of those sorts next to its
parent number instead of being swept to the end.

Hold **Shift** and click a second Khasra to select every number between the two, the way
a file list behaves:

| Action | Result |
|---|---|
| Click a number | Toggles just that Khasra and re-aims the sweep |
| Shift-click another | Selects the whole span from the last plain-clicked number |
| Shift-click the same end again | Clears that span again |
| Shift-click a different number | Widens or narrows the span from the same origin |

The origin stays ringed so you can see where the sweep starts. A sweep counts only the
chips currently visible, so filtering first narrows what it selects, and if the filter
hides the origin the next Shift-click degrades to an ordinary toggle instead of silently
selecting nothing.

There is **no limit on how many Khasras you may pick**, and the grid renders every one of
them. The largest list in the tehsil is **8,768** Khasras (Padshahan / Residential /
Link Road), and all 8,768 appear as clickable chips — measured at 388 ms to render and
0.2–0.5 ms per click. (Chips are indexed on render so a click repaints only what changed;
without that, repainting every chip turned each click into 8,768 DOM writes.) *Select all
matching* takes the lot in one go, which is the only sane way to select eight thousand.

**Rates genuinely differ per Khasra, so this is not a shortcut.** In a verified sample,
Alawal (Balkassar) / Residential / Link Road spans **Rs. 3,146 to Rs. 21,780 per Marla**
across twelve Khasras of one mouza, classification and location. Guessing one Khasra's
rate from its neighbour would be wrong by up to 7×, so each one is fetched individually.

**Why it is N requests, not one.** The official portal has no bulk rate endpoint. Its own
*Multiple Khasras* page accepts comma-, pipe- and JSON-array-separated numbers, and
`MultipleKhasraDCRateType` ("All Rate Applied" / "Highest Rate Applied") — every
combination returns an empty `KhasraRateString`. The portal's own code also calls
`MouzaRateByLandInfo` once per Khasra. A batch here is therefore N portal calls by
necessity, not by choice, and what keeps an uncapped batch from becoming a way to hammer a
government server is that the calls are issued **a few at a time**, never all at once:

| Setting | Value | Where |
|---|---:|---|
| Concurrent portal requests | 4 | `BATCH_CONCURRENCY` in `app.py` |
| Sanity ceiling on one request | 12,000 | `BATCH_CEILING` in `app.py` |
| Rate cache lifetime | 5 min | `_TTL_RATE` in `govapi.py` |

The ceiling is not a product limit. It has to clear the largest real list (8,768) for
"select everything" to work on the biggest mouza; it exists only so a malformed or
hostile payload cannot queue unbounded work.

Because concurrency is fixed, the *rate* against the portal is constant at roughly
**130 lookups/second** whatever the selection size — the ceiling bounds duration and
memory, not intensity. Measured, cold:

| Selection | Time | Rate |
|---|---:|---:|
| 1,035 Khasras (Ararbarar / Agricultural / Link Road) | 8.1 s | 128/s |
| 1,376 Khasras (Alawal / Residential / Off Road) | 10.3 s | 134/s |
| 3,000 Khasras (Padshahan / Residential / Link Road) | 24.8 s | 121/s |
| 1,376 Khasras, warm | 0.07 s | — |

So the full 8,768 extrapolates to roughly **70 seconds**; that specific size has not been
run, to avoid putting a minute of sustained load on a government server just to measure it.
Scaling is linear with no accumulation, and a repeat within five minutes is instant.

Progress is reported for real, not estimated. A run over 500 Khasras is handed to a
server-side job and polled, which both shows a live count ("3,412 of 8,768 done") and stops
a hosting platform's request timeout from killing a run the server is still doing — see
[putting it online](#putting-it-online-so-you-can-use-it-from-anywhere). Past 500 Khasras it
also asks first, quoting the size and the estimate, because at that point the load on a
third-party server is significant enough that it should be a deliberate choice.

Earlier versions capped a run at 100 Khasras and rendered at most 500 chips. Both are
gone.

Other behaviour worth knowing:

- **Partial success, never all-or-nothing.** A Khasra with no published rate comes back as
  an italicised "—" row with the reason on hover. It does not fail the rest.
- **Bulk results are not stored anywhere** — there is no saved-lookup table any more — so a
  1,000-row run cannot bury anything. The CSV is the record.
- **Duplicates and blanks are stripped** before any request is made, so a double-click
  cannot double the load.
- **Rural Khasras only.** Chakwal's urban property areas report a single Khasra at most,
  so the picker stays hidden there; the server rejects a non-rural batch rather than
  pretending.
- The picker only appears when the portal actually offers more than one Khasra.

## Tehsil Chakwal data coverage — read this

Verified live against the official portal on 27 Sep 2026.

| | Coverage | Status |
|---|---|---|
| Rural | 8 Qanoongoes, 226 mouzas, **all Khasra-based** | **Complete** |
| Urban | 2 towns, 9 revenue circles, ~110 property areas | **Patchy** |

### Rural — complete

All 226 mouzas report `IS_KHASRA_HIERARCHY` and none report `IS_SQUARE_NO_HIERARCHY`, so
the Square/Qila branch never applies here and the tool never shows it. All 8 Qanoongoes
return live rates:

| Qanoongoee | Mouzas | Sample mouza | Location | Rs / Acre | Rs / Marla |
|---|---:|---|---|---:|---:|
| Balkassar | 38 | Alawal | Link Road | 366,025 | 18,301 |
| Chakwal-1 | 5 | Karhan | Main Road | 2,000,000 | 100,000 |
| Chakwal-2 | 7 | Chak Gakhar | Link Road | 665,500 | 33,275 |
| Dhudial | 19 | Chak Bazeed | Link Road | 641,300 | 32,065 |
| Karyala | 30 | Amir Pur Mangan | Link Road | 556,600 | 27,830 |
| Khanpur | 79 | Ararbarar | Link Road | 459,195 | 22,960 |
| Mangwal | 25 | Achral | Main Road | 412,610 | 20,631 |
| Neela | 23 | Balo Kassar | Link Road | 968,000 | 48,400 |

All Agricultural. One sample parcel per Qanoongoee — the rate varies by mouza *and* by
location within it, so use the tool rather than this table for a real parcel.

### Urban — mostly empty in the portal's own data

Of 9 revenue circles, only **2** publish locations that lead to a rate. Both are in
Municipal Committee Chakwal City town:

| Revenue circle | Property area | Classification | Location | Rs / Marla |
|---|---|---|---|---:|
| Chakwal | Anarkali Bazar (Chappar Bazar → Hospital Rd) | Commercial | Link Road | 3,300,000 |
| Chakwal | Anarkali Bazar (Chappar Bazar → Hospital Rd) | Residential | Off Road | 1,265,000 |
| Thaneel Fatohi | Thaneel Fatohi | Commercial | Androon Abadi Deh | 143,000 |
| Thaneel Fatohi | Thaneel Fatohi | Residential | Androon Abadi Deh | 110,000 |

The other 7 revenue circles list property areas and land classifications but record **no
locations** for them, so there is no rate to look up. This is a gap in the official
portal's data, not a fault in this tool — the UI says so explicitly wherever a dropdown
comes up empty, so you can tell "no data published" apart from "something broke".

## Setup

Requires Python 3.11+.

```powershell
cd dc-rate-finder
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8765
```

Then open <http://127.0.0.1:8765>.

Runs on `127.0.0.1` only — it is not reachable from your network.

## Putting it online so you can use it from anywhere

### Start here: there is now a Windows app

**If you only need this on your own computer, do not deploy anything.**
`desktop/` builds a double-clickable `.exe` that needs no account, no card, no
domain, no server left running, and no tunnel. See **`desktop/README.md`**.

It keeps the same split as everything else: reference lists on disk, DC rate
fetched live from the portal on every lookup and never saved. Launching it costs
**zero** portal requests, because the lists ship with it — where the hosted
build has to walk ~2,300 of them on a cold start. A live rate arrives in ~0.7s.

The one thing it cannot do is be opened on a phone. That is the whole trade, and
it is the only reason the server builds below exist.

### The HTML on its own will not work, and this is not fixable

It is tempting to think of this as "an HTML file I can upload somewhere". It is not one
file, and the page genuinely cannot do the job without the Python beside it:

1. **The portal only offers legacy SHA-1 cipher suites.** Python needs
   `DEFAULT@SECLEVEL=1` to complete the handshake with it. A browser will not negotiate
   that under any configuration.
2. **The portal sends no CORS headers.** So a page served from one host cannot read its
   replies from another, no matter what the page is written in.
3. **All 29 `/api/*` endpoints, the shared rate cache and the concurrency limiter live
   server-side.** The rate cache being shared is also what stops a second visitor from
   re-fetching a rate the first one already paid for.

So the deployable unit is this app, whole. The good news is that it already serves its
own page at `/`, so hosting is a matter of running one process somewhere reachable:

```bash
uvicorn app:app --host 0.0.0.0 --port 8000
```

There is no separate frontend to publish and no build step. The files written for this are
`Dockerfile`, `docker-compose.yml`, `render.yaml`, `Procfile` and `.env.example`.

### Ways to do it

| Approach | Cost | What you need | Notes |
|---|---|---|---|
| **EdgeOne Pages** | **Free, no card** | An EdgeOne account | Built and ready as `deploy/`. One command, no repo, no server. See below. **This is the answer if you want live rates for nothing.** |
| **The offline build** | Free forever | Nothing at all | `Chakwal-Rate-Website` on the Desktop. A folder you open in a browser. No live rates — you type the DC rate in yourself. Works with no account, no network, no infrastructure. |
| **Firebase** | Blaze plan, card required | `npm i -g firebase-tools`, then a login | Built and ready as `deploy-firebase/`. Cloud Functions **will not deploy on the free Spark plan**, so this one costs. Only worth it if EdgeOne's IP range turns out to be blocked and you would rather it came from Google's name. |
| **Render** — commit the folder to a repo, create a Blueprint from `render.yaml` | Free tier sleeps on idle; `starter` is paid | A GitHub repo | Gives a public HTTPS URL with no server to look after. Set `plan: starter`; the free tier sleeps, which is useless for something you open from a phone. |
| **Any VPS + Docker** | ~€4–6/mo | A Linux box | `docker compose up -d`, then put Caddy or nginx in front for TLS. `docker-compose.yml` publishes on `127.0.0.1` only, on the assumption a reverse proxy fronts it — don't expose that port raw to the internet. |
| **Your own PC + a tunnel** | No monthly cost | A PC that stays on, plus Cloudflare Tunnel or ngrok | The portal traffic still comes from your home connection. Fine for a personal tool, but it is the one option that needs your machine alive. |

#### EdgeOne Pages, and what it changes

`deploy/` is a ready-to-upload EdgeOne Pages project. `public/` is the site —
`index.html`, `app.js` and `styles.css` are byte-for-byte copies of `static/`,
verified by SHA-256, so what goes online is what you were already looking at.
`cloud-functions/` runs the real `app.py` and `govapi.py`, also byte-identical.

Deploying is a single command; `deploy/README.md` has the exact invocation and
the Windows `npx.cmd` gotcha. **No GitHub account and no repository are
needed** — EdgeOne takes a direct folder upload.

The function is not optional. The portal sends no CORS headers, so a browser on any domain
cannot read its replies; the request has to be made server-side, on the same origin as the
page. Drop the function and the page loads and looks perfect while every lookup fails.

It sets `RATE_APP_SERVERLESS=1`, which switches off the three things that assume a process
which stays alive. Each refuses plainly with a `501` rather than failing quietly:

- **Nightly list refresh** — no instance survives until midnight, and the boot-time
  staleness check would otherwise re-walk all 1,070 lists (~2,300 portal calls) on *every*
  cold start. Lists are re-read on demand instead.
- **Queued bulk runs** — a job lives in one instance's memory, so the progress poll would hit
  an instance that never heard of it. Batches run synchronously inside one request, bounded
  by the platform's 120-second limit; the confirmation dialog warns first, because a run the
  platform cuts off returns nothing rather than a partial result. The largest list in the
  tehsil (8,768 Khasras) takes ~70 s, so it fits.
- **SQLite history** — answers empty. Nothing has written to it for a long time, and a
  read-only filesystem should not fail a request.

Everything else — every portal read, the rate and area maths, the tehsil scope guard, the
whole frontend — is unchanged. `state.serverless` comes from `/api/scope`, so the page
adapts to the deployment it is actually running on rather than to a guess.

One thing cannot be checked without an EdgeOne account: EdgeOne's own routing and build. The
code is verified by running it locally in serverless mode, but if the site loads and `/api/*`
404s, the fault is the `cloud-functions/` path mapping, not this application.

### Keep it at one worker

`BATCH_CONCURRENCY` is a per-process semaphore. Two uvicorn workers means eight requests in
flight against the government portal, four means twelve, and the politeness this app is
built on quietly stops being true. The `Dockerfile` and `Procfile` pin `--workers 1`, and
`render.yaml` pins `numInstances: 1` so there is only one container to run them in; if you
change either, that guarantee is gone.

**The same cap is weaker on a serverless platform, and this is worth knowing before
publishing.** `BATCH_CONCURRENCY` is per-process, but a warm serverless instance serves
several requests at once, so the real figure is `4 x concurrent-invocations-per-instance`.

- **Firebase** — fixable. `deploy-firebase/functions/main.py` pins `concurrency=1` and
  `max_instances=1`, so the in-app cap of 4 genuinely is the cap. The cost is that visitors
  queue rather than scale, and one bulk run blocks others while it works.
- **EdgeOne** — not fixable from here. `edgeone.json` exposes no concurrency knob, so the
  cap is whatever EdgeOne decides. Fine for a small site, and the free tier's million
  executions a month bounds it. If this ever went in front of real traffic, the limit
  would have to be enforced in front of the function (authentication, or a per-user job
  queue) rather than trusted from inside it.

### Long bulk runs are queued server-side, so a proxy timeout cannot kill them

A run over the largest mouza in the tehsil (8,768 Khasras) is ~65 seconds of continuous
requests. Hosting platforms end HTTP requests well before that — nginx defaults to 60
seconds, Render to 100 — so a synchronous batch comes back as a gateway timeout even
though the server is doing the work perfectly.

Past 500 Khasras the client therefore hands the run to a server-side job and polls for it:

- `POST /api/rates/batch/async` → returns `{job_id, total}` in about 100 ms
- `GET /api/rates/batch/async/{job_id}?results=false` → progress, no rows re-sent
- `GET /api/rates/batch/async/{job_id}?results=true` → the full result set

Both paths run identical validation and identical work — a queued batch is not a laxer way
around the guards. Finished results are kept 30 minutes, then dropped. This is also what
lets the status line show real progress ("3,412 of 8,768 done") instead of a spinner.

### This build has no authentication — on the record

It was chosen deliberately. Anyone holding the URL can spend this server's portal budget,
and the Punjab portal sees the requests coming from *your* host rather than from them. Two
things follow, and they are worth being clear about rather than discovering later:

- If a stranger scripts an 8,768-Khasra run every few minutes, that load originates at
  your IP. The concurrency ceiling still holds at four in flight, which bounds the rate but
  not the volume.
- There is no per-visitor accounting, so there is no way to tell a heavy legitimate run
  from an abusive one after the fact.

The lever is one environment variable's worth of work if you want it: a shared-secret
dependency plus a per-IP budget on the batch endpoints. It is not built because you asked
for open access, and it is not hidden either.

## Files

| File | Purpose |
|---|---|
| `app.py` | FastAPI routes, batch jobs, local history store, static hosting |
| `govapi.py` | Read-only client for the official portal + area-unit maths |
| `static/index.html` | UI markup |
| `static/app.js` | Cascade logic and rendering |
| `static/styles.css` | Styling |
| `history.db` | Created on first run; now always empty — nothing saves to it |
| `Dockerfile`, `docker-compose.yml` | Container, single worker, healthcheck, localhost-only publish |
| `render.yaml` | Render blueprint, one worker, `starter` plan |
| `Procfile` | Same start command for Heroku/Railway-style hosts |
| `.env.example` | The two environment variables the app reads (refresh hour, CORS origins) |
| `desktop/main.py` | Windows app entry point: local server + native window, imports the same `app.py` |
| `desktop/build.spec` | PyInstaller spec for the `.exe` |
| `desktop/web/` | The app's UI — a copy of `web-project/` plus `desktop.js`, the live-rate bridge |
| `desktop/README.md` | How to run, rebuild and debug the desktop app |
| `web-project/` | Source of the standalone offline build (`Chakwal-Rate-Website/`) |
| `deploy/`, `deploy-firebase/` | Prebuilt free-tier and paid hosting packages |

### The portal has no tehsil-wide Mouza endpoint

`MouzaByTehsilId`, `MouzasByTehsilId`, `MouzaByDistrictId` and `AllMouzaByTehsilId` all
return *"No HTTP resource was found"*. The only Mouza endpoint is `MouzaByLandInfo`,
scoped to a Qanoongoee. So `mouzas_by_tehsil()` walks the eight Qanoongoes concurrently
and merges the results. Those eight lookups are already cached for an hour, so the whole
tehsil costs one round trip to the portal.

A Mouza row carries no Qanoongoee of its own — `id`, `name`, `IS_KHASRA_HIERARCHY` and
`IS_SQUARE_NO_HIERARCHY` are all it returns — so the owner the UI displays is the one the
request was scoped to, recorded server-side. It is not read out of the row.

---

## Notes on the data source

A few things worth knowing, discovered by reading the portal's own JavaScript and
checking responses live:

**The signed DC value is encrypted.** Rate responses include `DcRatePerMarla`,
`DCLandRate`, and `DcFtSqRateStringEncrypt`. These are encrypted for use inside a signed
challan and are meaningless outside a transaction, so this tool ignores them. The **DC
value it shows is its own multiplication** of the official rate by your area — the same
thing the official page does in the browser. That is why the UI labels it as derived and
tells you to confirm on the official portal.

**The portal publishes two per-sq-ft figures that don't always agree.** In a verified
Chakwal urban case (Anarkali Bazar, Residential, Off Road) the portal reported
`Rs. 1,525` per sq ft while its own `Rs. 1,265,000` per Marla implies `Rs. 4,650.74`
per sq ft (at 272 sq ft per Marla). The tool shows both, labelled, and warns you when
they diverge. It does not silently pick one.

**The portal gives rural Locations no identifier at all.** Every rural Location row in
Chakwal comes back with `Id: 0` (176 of 176 sampled), and 403 of 528 Location lists hold
two or more such rows. Keyed on the id, "Link Road" and "Off Road" become the same
`<option>` value and the select silently reports whichever came first — so asking for a
rate in Off Road returns the **Link Road** rate, with no error anywhere. The Location and
Town lists are therefore keyed by name (which is also how the API queries them), and
`fill()` refuses any id-keyed list that would contain two rows sharing a value rather than
render a select that can only be wrong. Qanoongoes, mouzas, classifications, revenue
circles and property areas were all checked and do carry distinct ids.

**Acre and Marla are not single sizes in Punjab.** The official calculator offers
1 Acre = 8 / 9.65 / 9.8 Kanal, and 1 Marla = 272 / 225 sq ft. Both are exposed in the UI
under *Unit conversion settings*, defaulting to the portal's own defaults.

**TLS.** The portal's gateway only offers legacy SHA-1 cipher suites, which OpenSSL 3
rejects at its default security level. `govapi.py` lowers the security level to
`SECLEVEL=1` for that one host (still TLS 1.2). This is a workaround for the portal's
outdated configuration, not an endorsement of it — set `_TLS_LEGACY_COMPAT = False` in
`govapi.py` if the portal ever negotiates a modern suite.

**Polite client behaviour.** Reference data is cached for 1 hour, rates for 5 minutes,
identical concurrent requests are collapsed into one upstream call, and the frontend
sends no-cache headers so you're always testing your current edits.

## Limitations

- Read-only by design. It cannot generate a challan, pay stamp duty, or create a deed —
  those require the official portal.
- Depends on the official portal's internal endpoints staying stable. If the portal
  changes, this breaks; it is not a supported API.
- A parcel with no recorded rate returns a clear "no rate recorded" message rather than a
  zero. That usually means a wrong Khasra/Square number, or a parcel not yet rated under
  the selected classification.
- **Chakwal urban coverage is the portal's, not this tool's.** 7 of 9 revenue circles
  have no locations published, so the urban tab will often dead-end. Rural is unaffected
  and complete.
- **Bulk lookups issue one portal request per Khasra**, 4 at a time, because the portal
  offers no bulk endpoint and no way to raise its own rate. A full 1,376-Khasra mouza takes
  about ten seconds cold and is instant while the five-minute cache is warm.
- **Anyone with the URL can use it.** This build has no authentication, which was a
  deliberate choice. The concurrency ceiling still holds, so the rate is bounded — but the
  volume is not, and the portal sees the requests as coming from whatever host serves this.
  There is no per-visitor accounting.
- Not affiliated with the government. Verify anything that matters.
