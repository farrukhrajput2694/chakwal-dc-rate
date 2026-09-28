# Chakwal DC Rate Calculator — Windows desktop app

A double-clickable Windows app. No URL, no account, no server to keep alive, no
tunnel that dies when you restart something.

**The built app is at `dist\ChakwalDC\ChakwalDC.exe`** (7.6 MB, 42 MB with its
folder). There is a shortcut on the Desktop called *Chakwal DC Rates*.

---

## What it does, and what it deliberately does not

| | |
|---|---|
| Mouza / classification / location / Khasra lists | **On disk.** 226 mouzas, 908,221 Khasra numbers. Instant, and work with no internet. |
| DC rate | **Live, automatic, read-only.** Fetched from the Punjab e-Stamp portal as soon as the parcel chain is complete. There is no rate box and no button. |
| Value of a Khasra | Its own area × **its own** live rate, in the unit the portal quoted. |
| Multi-Khasra runs | **Each Khasra is looked up separately** and shown with its own rate and its own value. Capped at 200 per run. |
| Internet needed? | Only to read a rate. Picking a parcel works offline. |

### Why there is no rate field

The rate is not something you supply. That is the whole point of the app: a
hand-keyed figure cannot be traced back to a published DC Valuation row, and a
number that *looks* authoritative but was typed in is the exact failure this
project exists to prevent. So the rate is a readout, the rate's unit comes from
the portal rather than a dropdown of your choosing, and the result is labelled
**"Value of Khasra 947"** — the Khasra's value — with the DC rate shown as the
basis it is worked out from, not as the headline figure.

The rate is never written to disk. A saved rate goes stale quietly, and a stale
rate is worse than no answer — so there isn't one. Change anything in the chain
and the portal is asked again.

### Why multi-Khasra looks every Khasra up

The portal has no bulk rate endpoint — its own multi-Khasra screen also fetches
one Khasra at a time — so a run of N Khasras is N portal requests however it is
arranged. That is worth paying, because the previous version applied a single
rate to the whole selection and so *could not show you* that two Khasras in one
location carry different figures: it had assumed they didn't. It now looks each
one up, prints each one's own rate and unit, and says so plainly when a selection
turns out not to share one rate.

Requests are chunked 8 at a time against a server that keeps at most 4 portal
calls in flight, the table fills in as answers arrive, and a run stops at 200
Khasras rather than firing 8,768 requests at a government server — telling you
exactly how many it left out.

## Why this shape and not a website

The original brief was "a site I can open from anywhere", and that is what drove
the server builds. A desktop app cannot be opened from a phone, which is the
one thing a website does that this cannot.

What it gains for that trade:

- **Nothing to sign up for.** No hosting account, no card, no domain.
- **Nothing to keep running.** Close the window and the server stops. There is
  no URL that changes on restart, no tunnel that drops, nothing to relaunch.
- **The portal is not touched at all until you ask.** Launching costs **zero**
  portal requests. The hosted build had to walk ~2,300 of them on a cold start
  to rebuild lists that ship on disk; this one reads a file.
- **A live rate arrives in ~0.7s**, against ~7.5s through a tunnel.

## Running it

Double-click the `.exe`, or the Desktop shortcut. A window opens. That's it.

To find the local address (useful only if the window fails to appear) — it is
written beside the exe:

```
dist\ChakwalDC\desktop-url.txt
```

Other files that app writes next to itself:

| File | Meaning |
|---|---|
| `desktop-url.txt` | The `http://127.0.0.1:<port>/` it is serving on |
| `desktop-routes.txt` | The live route table — first thing to check if pages 404 |
| `desktop.log` | Warnings and errors, at `WARNING` and above |
| `desktop-error.log` | Written only if the app fails to start at all |

The port is chosen by the OS each run, so it changes. That is harmless — nothing
external depends on it.

## How it is put together

```
desktop/
  main.py        entry point: picks a port, starts the server, opens the window
  build.spec     PyInstaller spec
  web/           the UI + bundled reference data (a copy of web-project/)
    desktop.js   the live-rate bridge
```

`main.py` imports the **project's own** `app.py` — the same FastAPI app the
hosted build uses — and serves it to the window on `127.0.0.1`. It reimplements
none of the rate logic, so a fix to the shared app lands in both builds.

Two build-specific things are worth knowing if you edit this:

**The hosted routes have to be removed, not just preceded.** Starlette matches a
request against the *first* route that fits. Mounting a second `/static` and
adding a second `/` leaves both unreachable, and the hosted `index.html` and
`app.js` quietly win every request. The page still loads — it is just the wrong
page. `_retarget_static()` in `main.py` removes the hosted `/` and `/static`
first for exactly this reason.

**`window.__DESKTOP__` must be set before `app.js` loads.** `app.js` calls
`init()` as it is parsed, and `init()` writes build-specific wording into the
page. A flag set after that has already run arrives too late, and the page goes
on claiming it cannot reach the portal.

## Rebuilding

```powershell
cd "C:\Users\Creative Computer\Desktop\Chakwal-DC-Rate-Calculator"
.\.venv\Scripts\pip install pywebview pyinstaller
.\.venv\Scripts\pyinstaller.exe desktop\build.spec --noconfirm --clean
```

Output lands in `dist\ChakwalDC\`. Takes a couple of minutes.

After changing anything in `desktop\web\`, copy it into the built folder and
restart the app — the static mount reads from disk per request, so this avoids a
rebuild while iterating:

```powershell
Copy-Item desktop\web\* dist\ChakwalDC\_internal\web\ -Recurse -Force
```

### Two things that will bite you

**`sys.stdout` is `None` in a windowed build.** uvicorn's default log config
asks `sys.stdout` whether it is a terminal while building a colourised
formatter, and that raises `AttributeError: 'NoneType' object has no attribute
'isatty'` — killing the server before it serves anything, with no window to show
it in. `main.py` passes its own `log_config` that logs to a file and never
touches stdout. If you ever see that error, this is why.

**`main` and `app` are not importable by static analysis.** `main.py` reaches
`app` and `govapi` through `sys.path` at runtime, and uvicorn resolves its event
loop, HTTP protocol and lifespan modules by name at runtime. All are listed in
`build.spec` under `hiddenimports`. Remove them and the frozen app starts and
then serves nothing, which is a confusing way to fail.

## Known limits

- **Windows only**, and it needs the Edge WebView2 runtime — present by default
  on Windows 11 and on any current Windows 10. If the window never appears,
  `desktop-error.log` beside the exe will say so; failing that, it falls back
  to opening your default browser.
- **One machine at a time.** The port is per-run and there is no coordination, so
  two copies can both start on different ports. That is harmless but means the
  `desktop-url.txt` only describes the most recent launch.
- **Bulk runs stop at 200 Khasras.** Not a product limit — a politeness one. The
  portal answers one Khasra per request, and the largest list in the tehsil is
  8,768, so pricing a whole mouza would be 8,768 requests to somebody else's
  government server. The app tells you how many it skipped and why; raise
  `MAX_BATCH` in `desktop/web/desktop.js` if you are running your own server and
  disagree.
- **A run takes about a second per 10 Khasras.** One portal request each, chunked
  8 at a time. The table fills in as answers land, so it is not a frozen page.
- **Urban rates are absent** — that is the portal's data, not this app. All 118 of
  Chakwal's property areas report no rate. The app says so, shows the area
  conversions, and refuses to print a value rather than inventing one.
- **Unofficial.** Not affiliated with the Government of the Punjab. Verify on
  the official portal before relying on any figure.
