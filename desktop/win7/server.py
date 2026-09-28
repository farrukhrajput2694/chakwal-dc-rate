"""The Windows 7 build: the same rates, without the server stack.

Why this file exists at all
---------------------------
The normal Windows build runs FastAPI on uvicorn inside a pywebview window.
Neither is available on Windows 7:

  * pywebview needs the Edge WebView2 runtime, and there is no WebView2 build
    for Windows 7 at all. On Win7 pywebview does not even fail on import -- it
    installs, and then fails to create a window, which is a much worse bug to
    diagnose than a missing module.
  * uvicorn, pydantic and the pydantic-core Rust extension all make the same
    demand: Python 3.8. Python 3.8 is the last release Microsoft supports on
    Windows 7, so this file targets 3.8 and nothing newer.

What is dropped, and what is not
--------------------------------
Dropped: the webview window (the page opens in the default browser), pydantic
validation, uvicorn, the SQLite history table, the nightly reference refresh,
and every endpoint the desktop front end does not call.

Kept, deliberately: govapi.py itself, unmodified, so this build reads the same
portal, with the same request shape and the same rate arithmetic as the hosted
site and the modern desktop build. The three endpoints below -- /api/rate,
/api/rates/batch and /api/units -- are the complete set that desktop/web
asks for. Nothing else is needed to price land, and everything else would be a
dependency this platform cannot carry.

Consequence to be honest about: because there is no nightly refresh here, the
reference data (Mouza, Khasra and classification lists) is baked into the
offline .js files that ship with the app. Those go stale. A Mouza added to the
portal after this build was made will not appear, and the page says nothing
about it. The modern build does not have that problem because it re-reads the
portal at 00:00 and offers a manual refresh. On Windows 7 the fix is to
reinstall a newer build. That is a real limitation of the platform, not a
simplification, and it is recorded in README.md.

Written for Python 3.8. `from __future__ import annotations` is what makes the
PEP 604 `X | Y` annotations in this file legal on 3.8 -- without it they are a
TypeError at import time, not a syntax error, so a plain `compile()` check
passes and the program still fails to start.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import socket
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

# The project's own portal client, shared verbatim with the hosted site and the
# modern desktop build. Adding this directory to sys.path is what makes the
# PyInstaller build find it without a second copy in the bundle.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import govapi  # noqa: E402  (path must be set up first)

# --------------------------------------------------------------------------
# Scope: one tehsil, mirrored from app.py
# --------------------------------------------------------------------------
# Duplicated rather than imported, and that is a deliberate trade. Importing
# app.py would pull in FastAPI, pydantic and uvicorn -- the exact packages
# Windows 7 cannot run. These five constants are the entire scope definition
# and they are asserted against app.py by desktop/win7/check-parity.py, so
# drift is caught by a test rather than by a user noticing.
DISTRICT_ID = 21
DISTRICT_NAME = "Chakwal"
TEHSIL_ID = 75
TEHSIL_NAME = "Chakwal"
SCOPE_LABEL = "Tehsil Chakwal, District Chakwal"

# At most this many portal calls in flight at once, matching the modern build.
# The portal is a government service on a slow link; a bulk lookup of 200
# Khasras is 200 requests either way, and firing them all at once is how a
# client gets its IP rate-limited.
PORTAL_CONCURRENCY = 4

# Mirrors app.py's BATCH_CEILING. The front end chunks to 8 and caps a run at
# 200, so this is unreachable in practice; it exists so a hand-written request
# cannot turn into 8,768 portal calls.
BATCH_CEILING = 12000

ACRE_TO_KANAL_CHOICES = ("8", "9.65", "9.8")
MARLA_TO_SQFT_CHOICES = ("272", "225")
AREA_UNITS = ("Acre", "Kanal", "Marla", "SqFt")


class BadRequest(Exception):
    """A caller error, reported as HTTP 400 with {"detail": ...}.

    Same shape FastAPI's HTTPException produces, because desktop/web/postJSON
    reads `data.detail` directly. Pydantic's own 422 carries a *list* of objects
    in that field, which the browser would render as "[object Object]" -- so
    the string form here is both simpler and more legible in the UI.
    """

    def __init__(self, detail: str, status: int = 400) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status = status


# --------------------------------------------------------------------------
# Validation, replacing pydantic
# --------------------------------------------------------------------------


def _opt_int(body: dict[str, Any], key: str) -> int | None:
    """An optional integer, absent or null meaning "not supplied"."""
    value = body.get(key)
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        raise BadRequest(f"{key} must be a number, got {value!r}.")


def _str(body: dict[str, Any], key: str, default: str = "") -> str:
    value = body.get(key)
    return default if value is None else str(value)


def _choice(body: dict[str, Any], key: str, choices: tuple, default: str) -> str:
    value = _str(body, key, default)
    if value not in choices:
        raise BadRequest(
            "{0} must be one of {1}, got {2!r}.".format(key, ", ".join(choices), value)
        )
    return value


def _area(body: dict[str, Any]) -> float:
    """The area, which must be a positive number.

    app.py declares `area: float = Field(gt=0)`, so a zero or negative area is
    rejected there rather than producing a zero or negative land value. Kept
    identical here for the same reason.
    """
    raw = body.get("area", 1.0)
    if raw is None:
        raw = 1.0
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise BadRequest("area must be a number.")
    if not (value > 0):
        raise BadRequest("area must be greater than zero.")
    if value != value or value in (float("inf"), float("-inf")):  # NaN / inf
        raise BadRequest("area must be a finite number.")
    return value


def parse_request(body: Any) -> dict[str, Any]:
    """Validate a /api/rate body and return a normalised dict.

    Returns a plain dict rather than a model object. Everything downstream reads
    named keys, so a dataclass would add ceremony without adding safety, and
    the normalisation itself -- defaults, coercions -- is the part that matters.
    """
    if not isinstance(body, dict):
        raise BadRequest("Expected a JSON object.")

    land_type = _choice(body, "land_type", ("rural", "urban"), "")
    path = _choice(body, "path", ("khasra", "qila", "area"), "")

    req = {
        "land_type": land_type,
        "path": path,
        "district_id": _opt_int(body, "district_id"),
        "district_name": _str(body, "district_name"),
        "tehsil_id": _opt_int(body, "tehsil_id"),
        "tehsil_name": _str(body, "tehsil_name"),
        "mouza_id": _opt_int(body, "mouza_id"),
        "qanoongo_id": _opt_int(body, "qanoongo_id"),
        "mouza_name": _str(body, "mouza_name"),
        "property_area_id": _opt_int(body, "property_area_id"),
        "property_area_name": _str(body, "property_area_name"),
        "revenue_circle_id": _opt_int(body, "revenue_circle_id"),
        "land_classification_id": _opt_int(body, "land_classification_id"),
        "land_classification_name": _str(body, "land_classification_name"),
        "location": _str(body, "location"),
        "khasra_no": _str(body, "khasra_no").strip(),
        "square_no": _str(body, "square_no").strip(),
        "qila_no": _str(body, "qila_no").strip(),
        "town": _str(body, "town"),
        "floor_id": _opt_int(body, "floor_id"),
        "area": _area(body),
        "area_unit": _choice(body, "area_unit", AREA_UNITS, "Marla"),
        "acre_to_kanal": _choice(body, "acre_to_kanal", ACRE_TO_KANAL_CHOICES, "8"),
        "marla_to_sqft": _choice(body, "marla_to_sqft", MARLA_TO_SQFT_CHOICES, "272"),
    }
    _enforce_scope(req)
    return req


def _enforce_scope(req: dict[str, Any]) -> None:
    """This build serves one tehsil. Reject anything else, don't answer it.

    Identical to app.py's, including the message, so the hosted build and this
    one refuse the same requests for the same reasons.
    """
    if req["district_id"] is not None and req["district_id"] != DISTRICT_ID:
        raise BadRequest(
            "This calculator is scoped to {0}. "
            "Change DISTRICT_ID in server.py to serve another district.".format(SCOPE_LABEL)
        )
    if req["district_name"] and req["district_name"] != DISTRICT_NAME:
        raise BadRequest("This calculator is scoped to {0}.".format(SCOPE_LABEL))
    if req["tehsil_id"] is not None and req["tehsil_id"] != TEHSIL_ID:
        raise BadRequest(
            "This calculator is scoped to {0}. "
            "Change TEHSIL_ID in server.py to serve another tehsil.".format(SCOPE_LABEL)
        )
    if req["tehsil_name"] and req["tehsil_name"] != TEHSIL_NAME:
        raise BadRequest("This calculator is scoped to {0}.".format(SCOPE_LABEL))


def _require(value: Any, label: str) -> Any:
    if value in (None, ""):
        raise BadRequest("{0} is required.".format(label))
    return value


# --------------------------------------------------------------------------
# Valuation, mirroring app.py
# --------------------------------------------------------------------------


def _value_for_rate(rate: dict[str, Any], req: dict[str, Any]) -> dict[str, Any] | None:
    """Value the requested area at a portal rate, or None if there is no rate."""
    if not (rate.get("found") and rate.get("rate") is not None):
        return None

    rate_unit = govapi.canonical_unit(rate.get("unit")) or req["area_unit"]
    computed = govapi.land_value(
        area=req["area"],
        area_unit=req["area_unit"],
        rate=rate["rate"],
        rate_unit=rate_unit,
        acre_to_kanal=req["acre_to_kanal"],
        marla_to_sqft=req["marla_to_sqft"],
    )
    return {
        "area": req["area"],
        "area_unit": req["area_unit"],
        "area_in_rate_unit": govapi.round_area(computed["area_in_rate_unit"]),
        "rate": rate["rate"],
        "rate_unit": rate_unit,
        "rate_unit_raw": rate.get("unit"),
        "total": computed["total"],
        "total_sqft": govapi.round_area(computed["total_sqft"]),
        "implied_per_sqft": computed["implied_per_sqft"],
        # The portal reports its own per-sqft figure separately and it does not
        # always agree with (marla rate / sq ft per marla), so it is passed
        # through rather than reconciled.
        "portal_per_sqft": rate.get("per_sqft") or None,
    }


# --------------------------------------------------------------------------
# The portal calls
# --------------------------------------------------------------------------

# Set once at startup by the asyncio thread. A semaphore is not thread-safe
# and must be created inside the loop it is used from.
_limiter: asyncio.Semaphore | None = None


async def api_rate(req: dict[str, Any]) -> dict[str, Any]:
    """Fetch the DC rate for a parcel and value the land at it."""
    if req["land_type"] == "rural":
        shared = {
            "mouza_id": _require(req["mouza_id"], "Mouza"),
            "qanoongo_id": _require(req["qanoongo_id"], "Qanoongoee"),
            "mouza_name": req["mouza_name"],
            "land_classification_id": req["land_classification_id"],
            "location": req["location"],
        }
        if req["path"] == "khasra":
            _require(req["khasra_no"], "Khasra number")
            payload = dict(shared, khasra_no=req["khasra_no"])
            rate = await _portal(govapi.rate_rural_khasra, payload)
            parcel = "Khasra {0}".format(req["khasra_no"])
        elif req["path"] == "qila":
            _require(req["square_no"], "Square number")
            _require(req["qila_no"], "Qila number")
            payload = dict(shared, square_no=req["square_no"], qila_no=req["qila_no"])
            rate = await _portal(govapi.rate_rural_qila, payload)
            parcel = "Square {0} / Qila {1}".format(req["square_no"], req["qila_no"])
        else:
            raise BadRequest("Rural land is rated by Khasra or by Square/Qila number.")
        scope = "Mouza"
    else:
        shared = {
            "tehsil_id": _require(req["tehsil_id"], "Tehsil"),
            "town": req["town"],
            "revenue_circle_id": _require(req["revenue_circle_id"], "Revenue Circle"),
            "property_area_id": _require(req["property_area_id"], "Property Area"),
            "property_area_name": req["property_area_name"],
            "land_classification_id": req["land_classification_id"],
            "floor_id": req["floor_id"],
            "location": req["location"],
            "area": req["area"],
        }
        if req["path"] == "khasra":
            _require(req["khasra_no"], "Khasra number")
            payload = dict(shared, khasra_no=req["khasra_no"])
            rate = await _portal(govapi.rate_urban_khasra, payload)
            parcel = "Khasra {0}".format(req["khasra_no"])
        elif req["path"] == "qila":
            _require(req["square_no"], "Square number")
            _require(req["qila_no"], "Qila number")
            payload = dict(shared, square_no=req["square_no"], qila_no=req["qila_no"])
            rate = await _portal(govapi.rate_urban_qila, payload)
            parcel = "Square {0} / Qila {1}".format(req["square_no"], req["qila_no"])
        elif req["path"] == "area":
            rate = await _portal(govapi.rate_urban_area, shared)
            parcel = "Property Area {0}".format(req["property_area_name"]).strip()
        else:
            raise BadRequest("Unknown valuation path.")
        scope = "Property Area"

    value = _value_for_rate(rate, req)

    # Why there is no rate. The wording follows the chain, because telling the
    # reader to check "the Khasra/Square number" for a property area -- which has
    # neither -- sends them looking for a field that does not exist.
    if rate.get("found"):
        message = None
    elif req["land_type"] == "urban":
        message = (
            "The official portal has no DC rate recorded for this property area. "
            "It is either not yet rated, or it is rated under a different town, "
            "revenue circle or floor."
        )
    else:
        message = (
            "The official portal has no DC rate recorded for this Khasra. This "
            "usually means the Khasra number is wrong, or the parcel is not yet "
            "rated for the selected classification."
        )

    return {
        "found": bool(rate.get("found")),
        "rate": rate,
        "value": value,
        "parcel": parcel,
        "scope": scope,
        "source": govapi.OFFICIAL_BASE,
        "message": message,
    }


async def _portal(fn, payload: dict[str, Any]) -> dict[str, Any]:
    """One portal call, inside the shared concurrency limit.

    Every portal request in this build goes through here, so the limit of 4 is
    a property of the program rather than of each call site.
    """
    assert _limiter is not None, "the limiter is set by serve() before any request"
    async with _limiter:
        return await fn(payload)


async def api_rates_batch(req: dict[str, Any], raw_khasras: Any) -> dict[str, Any]:
    """DC rate for many Khasras at the same Mouza/classification/location.

    The portal has no bulk endpoint -- its own multi-Khasra screen also issues
    one request per Khasra -- so this is N lookups, at most 4 at a time.
    """
    if req["land_type"] != "rural" or req["path"] != "khasra":
        raise BadRequest("Bulk lookup is available for rural Khasras only.")

    if not isinstance(raw_khasras, list):
        raise BadRequest("khasras must be a list of Khasra numbers.")

    # De-duplicate while preserving the order the user picked them in, and drop
    # blanks, so a double-click cannot double the load on the portal.
    numbers: list[str] = []
    seen: set[str] = set()
    for raw in raw_khasras:
        number = str(raw).strip()
        if not number or number in seen:
            continue
        seen.add(number)
        numbers.append(number)

    if not numbers:
        raise BadRequest("Select at least one Khasra.")
    if len(numbers) > BATCH_CEILING:
        raise BadRequest(
            "{0} Khasras in one request; the ceiling is {1}. The largest list in "
            "the tehsil is 8,768, so a request this size is a bug, not a "
            "selection.".format(len(numbers), BATCH_CEILING)
        )

    shared = {
        "mouza_id": _require(req["mouza_id"], "Mouza"),
        "qanoongo_id": _require(req["qanoongo_id"], "Qanoongoee"),
        "mouza_name": req["mouza_name"],
        "land_classification_id": req["land_classification_id"],
        "location": req["location"],
    }

    async def one(number: str) -> dict[str, Any]:
        try:
            rate = await _portal(govapi.rate_rural_khasra, dict(shared, khasra_no=number))
        except govapi.PortalError as exc:
            # One unreachable Khasra should not sink the other 99. A portal
            # failure is reported per row rather than raised, because in a bulk
            # run the honest answer is "these worked, these did not".
            return {
                "khasra": number,
                "found": False,
                "value": None,
                "rate": None,
                "rate_unit": None,
                "error": str(exc),
            }
        value = _value_for_rate(rate, req)
        return {
            "khasra": number,
            "found": bool(value),
            "value": value,
            "rate": rate.get("rate"),
            "rate_unit": (value or {}).get("rate_unit") or rate.get("unit"),
            "error": None if value else "no_rate",
        }

    results = await asyncio.gather(*(one(n) for n in numbers))

    rated = [r for r in results if r["found"]]
    rates = [r["value"]["rate"] for r in rated]
    distinct = sorted({round(rate, 6) for rate in rates})
    units = {r["rate_unit"] for r in rated}

    summary = {
        "requested": len(numbers),
        "rated": len(rated),
        "unrated": len(results) - len(rated),
        "distinct_rate_count": len(distinct),
        "all_same_rate": len(distinct) <= 1 and bool(rated),
        "min_rate": min(rates) if rates else None,
        "max_rate": max(rates) if rates else None,
        # Rate units can differ between Khasras of one Mouza, so a total is
        # only meaningful when they all share a unit.
        "rate_unit": (rated[0]["rate_unit"] if rated else None),
        "units_differ": len(units) > 1,
        "total_value": (
            sum(r["value"]["total"] for r in rated) if rated and len(units) == 1 else None
        ),
    }

    return {
        "count": len(results),
        "results": results,
        "summary": summary,
        "area": {
            "area": req["area"],
            "area_unit": req["area_unit"],
            "acre_to_kanal": req["acre_to_kanal"],
            "marla_to_sqft": req["marla_to_sqft"],
        },
        "mouza": req["mouza_name"],
        "land_classification": req["land_classification_name"],
        "location": req["location"],
        "source": govapi.OFFICIAL_BASE,
    }


# --------------------------------------------------------------------------
# asyncio plumbing
# --------------------------------------------------------------------------


class PortalLoop:
    """An asyncio event loop on its own thread, for the portal calls.

    govapi is async, and http.server is not -- it is one blocking request per
    thread. Rather than give up async, the loop runs in a background thread and
    the handler threads hand it work with run_coroutine_threadsafe and wait for
    the answer. That keeps httpx's connection pool shared across requests,
    which is the whole reason for using it.
    """

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._run, name="portal-loop", daemon=True
        )
        self._thread.start()
        self._ready.wait(timeout=30)
        if not self._ready.is_set():
            raise RuntimeError("the portal event loop did not start within 30s")

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        global _limiter
        _limiter = asyncio.Semaphore(PORTAL_CONCURRENCY)

        self._loop = loop
        self._ready.set()
        try:
            loop.run_forever()
        finally:
            try:
                loop.run_until_complete(govapi.aclose())
            except Exception:  # noqa: BLE001 - shutdown must not raise
                pass
            loop.close()

    def run(self, coro, timeout: float = 180.0) -> Any:
        """Run a coroutine on the loop thread and return its result."""
        if self._loop is None:
            raise RuntimeError("the portal event loop is not running")
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=timeout)

    def stop(self) -> None:
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread is not None:
            self._thread.join(timeout=10)


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

WEB_ROOT_NAME = "web"

# Only the handful of types the page actually uses. Guessing from the extension
# with mimetypes alone is a portability risk -- the registry decides some of
# it -- so the important ones are pinned and the rest fall back to octet-stream.
_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
}

MAX_BODY_BYTES = 8 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    """Serves the page, the three endpoints, and nothing else."""

    server_version = "ChakwalDC/win7"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # Injected by serve().
    portal: PortalLoop = None  # type: ignore[assignment]
    web_root: str = ""

    # -- plumbing ---------------------------------------------------------

    def log_message(self, fmt: str, *args: Any) -> None:
        """Quiet by default.

        http.server logs one line per request to stderr. In a windowed app with
        no console that output goes nowhere, and at 4 requests per bulk Khasra
        it would be a great deal of nothing.
        """
        return

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # The page is served from 127.0.0.1 and must not be cached: the whole
        # point of the design is that a rate is fetched now, not read from a
        # stale copy of the page.
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _error(self, status: int, detail: str) -> None:
        # {"detail": ...} is what desktop/web/postJSON reads for its message.
        self._send_json(status, {"detail": detail})

    def _read_json(self) -> Any:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise BadRequest("Content-Length is not a number.")
        if length <= 0:
            raise BadRequest("Expected a JSON body.")
        if length > MAX_BODY_BYTES:
            raise BadRequest("Request body is too large.")
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise BadRequest("Body is not valid JSON: {0}".format(exc))

    # -- routing ----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if path == "/api/units":
            self._send_json(200, api_units())
        elif path == "/health":
            self._send_json(200, {"ok": True, "build": "win7", "python": sys.version.split()[0]})
        elif path in ("/", "/index.html"):
            self._serve_file("index.html")
        elif path.startswith("/static/"):
            self._serve_file(path[len("/static/"):])
        else:
            self._error(404, "Not found.")

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        try:
            if path == "/api/rate":
                body = self._read_json()
                req = parse_request(body)
                result = self.portal.run(api_rate(req))
                self._send_json(200, result)
            elif path == "/api/rates/batch":
                body = self._read_json()
                if not isinstance(body, dict):
                    raise BadRequest("Expected a JSON object.")
                khasras = body.get("khasras", [])
                req = parse_request(body)
                result = self.portal.run(api_rates_batch(req, khasras))
                self._send_json(200, result)
            else:
                self._error(404, "Not found.")
        except BadRequest as exc:
            self._error(exc.status, exc.detail)
        except govapi.PortalError as exc:
            # The portal is unreachable. Say so in the caller's own terms rather
            # than as an empty 500, and never as a rate.
            self._error(502, "Could not reach the official portal: {0}".format(exc))
        except socket.timeout:
            self._error(504, "Timed out waiting for the official portal.")
        except Exception as exc:  # noqa: BLE001 - a bug must still be reportable
            self._error(500, "{0}: {1}".format(type(exc).__name__, exc))

    # -- static files -----------------------------------------------------

    def _serve_file(self, relative: str) -> None:
        # Resolve, then confirm the result is still inside web_root. Without
        # this, a request for /static/../../govapi.py would read the app's own
        # source off disk. The check is done on the resolved path rather than on
        # the requested one, because that is the only form that cannot be lied
        # to with "..%2f" or a symlink.
        root = os.path.realpath(self.web_root)
        target = os.path.realpath(os.path.join(root, relative))
        if target != root and not target.startswith(root + os.sep):
            self._error(403, "Forbidden.")
            return
        if os.path.isdir(target):
            self._error(404, "Not found.")
            return
        if not os.path.isfile(target):
            self._error(404, "Not found: {0}".format(relative))
            return

        ext = os.path.splitext(target)[1].lower()
        content_type = _CONTENT_TYPES.get(ext, "application/octet-stream")
        try:
            with open(target, "rb") as handle:
                body = handle.read()
        except OSError as exc:
            self._error(500, "Could not read {0}: {1}".format(relative, exc))
            return
        self._send(200, body, content_type)


def api_units() -> dict[str, Any]:
    """Unit vocabulary and conversion constants, exactly as app.py returns them."""
    return {
        "area_units": list(govapi.AREA_UNITS),
        "acre_to_kanal": govapi.ACRE_TO_KANAL,
        "kanal_to_marla": govapi.KANAL_TO_MARLA,
        "marla_to_sqft": govapi.MARLA_TO_SQFT,
    }


def serve(web_root: str, host: str = "127.0.0.1", port: int = 0) -> tuple:
    """Start the server and return (httpd, thread, portal_loop, base_url).

    Binds to 127.0.0.1 on an ephemeral port unless told otherwise. Loopback only
    is deliberate: the page reads official rates, and a service answering
    unauthenticated rate queries should not be reachable from the local network
    just because a laptop joined a café hotspot.
    """
    portal = PortalLoop()
    portal.start()

    handler = type("BoundHandler", (Handler,), {"portal": portal, "web_root": web_root})

    class Server(ThreadingHTTPServer):
        daemon_threads = True
        allow_reuse_address = True

    httpd = Server((host, port), handler)
    thread = threading.Thread(target=httpd.serve_forever, name="http", daemon=True)
    thread.start()

    bound_host, bound_port = httpd.server_address[:2]
    base_url = "http://{0}:{1}/".format(bound_host, bound_port)
    return httpd, thread, portal, base_url


def main() -> int:
    """Entry point: serve, open the browser, and stay up until closed.

    Closing the browser tab does not stop the program -- there is no way to
    detect that from here -- so the console is kept open with a message and the
    process waits for the user to close it. On Windows 7 a console window is
    the only way to stop the app, which is a small regression against the
    windowed modern build and is a consequence of having no webview.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    web_root = os.path.join(here, WEB_ROOT_NAME)
    if not os.path.isdir(web_root):
        sys.stderr.write("Web assets are missing from {0}\n".format(web_root))
        return 2

    httpd, _thread, portal, base_url = serve(web_root)
    print("Chakwal DC Rate Calculator (Windows 7 build)")
    print("  {0}".format(base_url))
    print("")
    print("Rates are read live from the official Punjab e-Stamp portal.")
    print("Close this window to stop the program.")
    try:
        webbrowser.open(base_url)
    except Exception:  # noqa: BLE001 - no browser is not fatal, the URL is printed
        pass
    try:
        while True:
            time_sleep()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()
        portal.stop()
    return 0


def time_sleep() -> None:
    """A one-second sleep, in a function so it can be replaced in tests."""
    import time

    time.sleep(1)


if __name__ == "__main__":
    raise SystemExit(main())
