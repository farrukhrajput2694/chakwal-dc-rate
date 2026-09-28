# Windows 7 build

## Status: UNVERIFIED

**This build has never been run on Windows 7.** It was built and tested on
Windows 10, where it works, and the platform-specific claims below are derived
from the Python version, the PyInstaller version, the PE import tables of the
actual executable, and the dependency set — not from a Windows 7 machine.

The first install on a real Windows 7 PC *is* the test. Treat it that way.

## What it is

The same calculator, same portal, same arithmetic — built for a platform the
normal build cannot run on.

| | Modern build | Windows 7 build |
|---|---|---|
| Python | 3.12 | 3.8.10 |
| PyInstaller | 6.x | 5.13.2 |
| Window | pywebview + WebView2 | default browser |
| Server | FastAPI + uvicorn | `http.server` (stdlib) |
| Validation | pydantic | hand-written |
| Size | ~44 MB | ~20 MB |
| Reference data | re-read nightly at 00:00 | frozen into the build |

## Why it is built this way

**No WebView2.** pywebview renders in a WebView2 window, and Microsoft has never
shipped WebView2 for Windows 7. The nasty part is the failure mode: pywebview
*imports fine* on Win7 — it is pure Python — and then throws when asked to
create a window. So `ImportError`-based detection is not enough. The modern
`main.py` now checks for the runtime's registry key instead; this build skips
the question entirely and opens the browser.

**Python 3.8.** Microsoft supports 3.8 on Windows 7 and will not support 3.9+.
A build made with a newer interpreter produces an executable that cannot start.

**PyInstaller 5.13.2.** PyInstaller 6 dropped Windows 7 as a target.

**No FastAPI, pydantic or uvicorn.** All three require Python versions Windows 7
cannot run.

**Kept: `govapi.py`, unchanged.** The same file the hosted site and the modern
build use, so there is one portal client and one rate calculation. Not a copy
with edits — the same file.

## What is genuinely worse on Windows 7

**Reference data goes stale.** The modern build re-reads Mouza, Khasra and
classification lists from the portal every night at 00:00. This build cannot
(pydantic, SQLite and the refresh loop are all gone), so it ships the lists
frozen as of the build date. **A Mouza added to the portal after this build will
not appear, and the page will not tell the user that.** The fix is to install a
newer build. This is a platform limitation, not an oversight.

**The page needs a modern browser.** `app.js` uses optional chaining (`?.`) and
nullish coalescing (`??`), and `fetch` does not exist in Internet Explorer 11.
Chrome 109, Firefox 115 ESR and Edge 109 are the last versions that run on
Windows 7 and all three work. `browser-check.js` detects the rest and replaces
the page with an explanation instead of a blank window.

**A console window stays open.** With no window of its own, the console is the
program's window: it prints the address and it is what you close to stop. This
is a regression against the modern build's single-window experience.

## Building it

Build environment: `C:\Users\Creative Computer\Desktop\_win7env` (Python 3.8.10,
httpx 0.27.2, PyInstaller 5.13.2). **Not** the project's main venv — the modern
one is Python 3.12 and would produce an exe that cannot start on Win7.

```powershell
& C:\Users\Creative Computer\Desktop\_win7env\Scripts\python.exe `
    -m PyInstaller --noconfirm --clean desktop\win7\build-win7.spec
& 'C:\Users\Creative Computer\AppData\Local\Programs\Inno Setup 6\ISCC.exe' `
    desktop\win7\ChakwalDC-Win7.iss
```

Produces `dist\ChakwalDC-win7\` and `dist\installer\ChakwalDC-Win7-Setup-1.0.0.exe`.

## The MSVC runtime — a hard requirement, not a nicety

Read from the PE import tables of the actual build, not assumed:

- `python38.dll`, `_ssl.pyd`, `_socket.pyd`, `select.pyd` all import
  **`VCRUNTIME140.dll`**
- all four import the **`api-ms-win-crt-*.dll`** family (the Universal C Runtime)

Windows 10 has both. **Stock Windows 7 has neither**, so the installer runs
Microsoft's own signed `vc_redist.x64.exe` (14.44.35211.0) first and checks
`VCRUNTIME140.dll` appeared afterwards. Without it the app cannot start at all —
there is no window, no message, no log; it simply does nothing.

**Windows 7 also needs update KB2999226**, which carries the UCRT. Installing
Windows Update on the target machine first is the reliable way to be sure. An
installer cannot check this: on a machine that has never been patched there is
no way to distinguish "KB2999226 missing" from "present".

## The three endpoints

`desktop/web/desktop.js` calls exactly three, and this build implements exactly
those:

| Endpoint | Purpose |
|---|---|
| `POST /api/rate` | one parcel's rate, and the area valued at it |
| `POST /api/rates/batch` | many Khasras, at most 4 portal calls at once |
| `GET /api/units` | unit vocabulary and conversion constants |

Plus static files and `/health`. No history table, no nightly refresh, no
`/api/convert` — nothing the page asks for.

## Tests

```powershell
& C:\Users\Creative Computer\Desktop\_win7env\Scripts\python.exe `
    desktop\win7\test-server.py
```

129 checks. Three parts:

1. **Live portal** — the known Khasra 947 (Alawal, Agricultural, Link Road) must
   come back at Rs. 366,025/Acre, and 3.5 Kanal must be Rs. 160,135.9375.
2. **The cap is real** — 12 Khasras must produce a peak of exactly 4 concurrent
   portal calls. Measured inside `govapi.rate_rural_khasra`, because wrapping
   `server._portal` would count the wrapper's own concurrency and always report
   12 — the semaphore is applied *inside* it. Easy to mistake for a limiter bug.
3. **Parity with the FastAPI build** — 29 shared cases, run through *both*
   implementations and compared decision by decision. The two cannot share an
   interpreter, so each is driven by the interpreter that can run it
   (`parity-probe.py --mode win7` / `--mode fastapi`) and the JSON is compared.

   The one intended difference: FastAPI answers a constraint violation with 422
   and a list of pydantic error objects; this build has no pydantic and answers
   400 with a sentence. `postJSON` renders `data.detail` directly, so a list of
   objects would appear to the user as `[object Object]`. The string form is the
   better one.

**Exit codes:** `0` all passed, `1` something failed, `2` passed but the portal
was unreachable so some checks were skipped. A run with skips is not a pass —
the portal is flaky, and it has failed and succeeded minutes apart.

## Test checklist for the first Windows 7 machine

1. Install. It should be quiet; the VC++ runtime takes a moment.
2. Confirm a browser opens and the page loads. If it shows "this browser is too
   old", install Chrome 109+ and reopen.
3. Look up Khasra 947, Alawal, Agricultural, Link Road. Expect **Rs. 366,025
   per Acre** and, at 3.5 Kanal, **Rs. 160,135.9375**.
4. Select three Khasras and price them in bulk. Expect three rows, each with its
   own rate.
5. Check `desktop.log` in `%LOCALAPPDATA%\ChakwalDC`.
6. Uninstall from Add/Remove Programs. Confirm nothing is left in Program Files.
