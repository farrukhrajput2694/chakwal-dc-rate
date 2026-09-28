"""
app.py - Chakwal DC Rate Calculator (unofficial local helper).

An UNOFFICIAL, read-only convenience tool for looking up District Collector
(DC) land rates in Tehsil Chakwal, District Chakwal. Not affiliated with,
endorsed by, or operated by the Government of the Punjab, the Board of
Revenue, or PLRA. No government branding is used.

Every rate shown is fetched live from the official e-Stamping portal at
request time. Figures that matter legally must be confirmed on the official
portal before being relied on.
"""

from __future__ import annotations

import asyncio
import csv
import io
import logging
import os
import sqlite3
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import govapi

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DB_PATH = BASE_DIR / "history.db"

# ---------------------------------------------------------------------------
# Scope: this build is a calculator for one tehsil.
#
# The underlying client (govapi.py) is district- and tehsil-agnostic; these
# constants are what pin the UI and the API to Tehsil Chakwal in District
# Chakwal. Change all four values to retarget the tool -- no other edit is
# required. Both the rural and urban chains are kept.
# ---------------------------------------------------------------------------
DISTRICT_ID = 21
DISTRICT_NAME = "Chakwal"
TEHSIL_ID = 75
TEHSIL_NAME = "Chakwal"

SCOPE_LABEL = f"Tehsil {TEHSIL_NAME}, District {DISTRICT_NAME}"

# ---------------------------------------------------------------------------
# Bulk Khasra lookups.
#
# The official portal has no bulk rate endpoint -- its own "Multiple Khasras"
# screen also fetches one Khasra at a time (MouzaRateByLandInfo, once per
# Khasra), so a batch here is N portal calls no matter how it is arranged.
# There is no limit on how many Khasras you may ask for; what keeps that from
# turning into a way to hammer a government server is that the calls are issued
# a few at a time rather than all at once:
#
#   BATCH_CONCURRENCY how many portal calls are in flight at once
#   BATCH_CEILING     sanity bound on a single request, set above the largest
#                     real Khasra list, only so a malformed or hostile payload
#                     cannot queue unbounded work
#
# The largest Khasra list in the tehsil is 8,768 (Padshahan / Residential /
# Link Road), so the ceiling has to clear that for "select everything" to work
# on the biggest mouza. It is not a product limit.
#
# Rates are cached for 5 minutes and identical concurrent lookups are
# collapsed, so re-running an overlapping batch costs almost nothing.
# ---------------------------------------------------------------------------
BATCH_CONCURRENCY = 4
BATCH_CEILING = 12000

# Serverless mode.
#
# Set RATE_APP_SERVERLESS=1 on a platform where each request may get a fresh
# process (EdgeOne Pages Cloud Functions, Lambda, Cloud Run Jobs). Three parts of
# this app assume a process that stays alive, and all three are actively harmful
# on a platform that does not provide one:
#
#   * The nightly refresh loop. Its startup check would see an empty cache and
#     decide the lists are a day old, then re-walk all 1,070 of them -- about
#     2,300 portal calls -- on every cold start. On a platform that starts a new
#     instance constantly that is a self-inflicted flood, so it is off.
#   * The queued batch job. It lives in this process's memory, so a status poll
#     would land on a different instance and find nothing. There is nowhere to
#     put it that is both shared and cheap, so it is off and batches are
#     synchronous, bounded by the platform's request timeout instead.
#   * The SQLite history file. Nothing writes to it any more, but a read-only or
#     ephemeral filesystem should not be able to fail a request.
#
# What survives unchanged, and is most of the app: every portal read, the rate
# maths, the tehsil scope guard, and the whole frontend. Reference lists are
# still cached in-process, which on a long-lived host is a saving and on a
# serverless host simply means each warm instance reuses what it already read.
SERVERLESS = os.environ.get("RATE_APP_SERVERLESS", "").strip().lower() in (
    "1", "true", "yes", "on",
)

_limiter: "_PriorityLimiter" | None = None
JOBS: dict[str, "_BatchJob"] = {}


class _PriorityLimiter:
    """Concurrency ceiling where a user's lookup outranks background work.

    A plain asyncio.Semaphore is wrong here. The nightly refresh parks ~2,300
    list reads on the same queue a user's bulk run uses, and FIFO ordering means
    an 8,768-Khasra run would sit behind all of them and look hung -- measured
    as the first Khasra waiting tens of seconds for its turn.

    So the ceiling is still BATCH_CONCURRENCY (the portal never sees more than
    that), but the refresh stands aside whenever a user is waiting. A refresh
    can therefore be delayed by a long bulk run, which is the right way round:
    the user asked, the refresh did not.

    Implementation note: this keeps two explicit FIFO queues of waiters and hands
    a freed slot to exactly one of them, rather than using Condition.notify_all.
    That matters at bulk scale. An 8,768-Khasra run parks 8,768 coroutines, so
    broadcasting on every release means each of ~8,768 releases wakes all 8,768
    waiters -- tens of millions of pointless wakeups, which starves the event
    loop badly enough that the progress endpoint stops answering too. Measured:
    3,000 Khasras took 69.7s that way against 22.9s with a targeted handoff.
    """

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._active = 0
        self._user_q: "deque[asyncio.Future]" = deque()
        self._bg_q: "deque[asyncio.Future]" = deque()
        self._cond: asyncio.Condition | None = None

    def _condition(self) -> asyncio.Condition:
        # Built lazily so it binds to the running loop, not to import time.
        if self._cond is None:
            self._cond = asyncio.Condition()
        return self._cond

    def _grantable(self, user: bool) -> bool:
        if self._active >= self._limit:
            return False
        # Background work only proceeds when no user is queued.
        return user or not self._user_q

    def _wake_one(self) -> None:
        """Hand the freed slot to the highest-priority waiter, if any."""
        for queue in (self._user_q, self._bg_q):
            while queue:
                waiter = queue.popleft()
                if waiter.done():
                    # Cancelled or already granted; drop it and try the next.
                    continue
                try:
                    waiter.set_result(None)
                except asyncio.InvalidStateError:  # pragma: no cover
                    continue
                return

    @asynccontextmanager
    async def slot(self, *, user: bool = True):
        cond = self._condition()
        loop = asyncio.get_running_loop()
        queue = self._user_q if user else self._bg_q

        while True:
            async with cond:
                if self._grantable(user):
                    self._active += 1
                    break
                waiter = loop.create_future()
                queue.append(waiter)
                # A slot may already be free but held back by the priority rule
                # (we are background work and a user is queued). Nudge whoever
                # does qualify, or the free slot sits idle until the next release.
                if self._active < self._limit:
                    self._wake_one()
            # Deliberately outside the `async with`: awaiting a bare future does
            # not release the condition lock, so doing this inside would leave
            # every sleeping waiter holding it and the releasing task -- the one
            # that has to hand the slot on -- could never acquire it.
            await waiter

        try:
            yield
        finally:
            async with cond:
                self._active -= 1
                self._wake_one()


def _get_limiter() -> "_PriorityLimiter":
    """Lazily bound so the semaphore attaches to the running loop, not import."""
    global _limiter
    if _limiter is None:
        _limiter = _PriorityLimiter(BATCH_CONCURRENCY)
    return _limiter

OFFICIAL_DC_VALUATION_URL = (
    "https://es.punjab-zameen.gov.pk/eStampCitizenPortal/ChallanFormView/"
    "RateOfChallanView?name=PropertyDCValuation"
)


log = logging.getLogger("refresh")


def _env_int(name: str, default: int, low: int, high: int) -> int:
    """Read an int from the environment, ignoring anything unusable.

    A typo in a deploy variable should fall back to the default rather than
    crash the app on boot -- a rate calculator that will not start because
    someone wrote RATE_APP_REFRESH_HOUR=midnight is worse than one that
    refreshes at 00:00.
    """
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw.strip())
    except ValueError:
        log.warning("%s=%r is not a number; using %d", name, raw, default)
        return default
    if not low <= value <= high:
        log.warning(
            "%s=%d is out of range %d-%d; using %d", name, value, low, high, default
        )
        return default
    return value


# ---------------------------------------------------------------------------
# Nightly reference refresh.
#
# Rates are never stored and never pre-fetched -- they come from the portal on
# every request, and there are 916,700 of them in this tehsil, so caching them
# is not an option (one full pass is ~117 minutes of continuous portal load).
#
# Reference data is different. The whole tehsil is 8 Qanoongoes -> 226 mouzas
# -> 1,070 classification/location combinations -> their Khasra lists, which is
# about 2,300 list calls and a few minutes at the polite concurrency. That is
# cheap, and it is the only thing that can actually go stale: a Khasra the portal
# adds shows up as a missing chip until the list is re-read.
#
# So the job below re-walks and re-seeds the reference lists once a day, and
# nothing else. It deliberately does not touch the rate cache.
#
# REFRESH_HOUR / REFRESH_MINUTE are a wall-clock time in PAKISTAN time, not in
# the host's local time.
#
# That distinction is the whole reason this is written down rather than left to
# `datetime.now()`. A hosted container (Render, Hetzner, Fly) runs on UTC, where
# the same number means a different hour of the day in Chakwal. Measured, not
# assumed: a container whose clock reads 00:00 UTC is 05:00 in Chakwal, so
# "midnight" would land at 5am for the people who read the result.
#
# Note for anyone correcting this later: 5 is NOT the right offset to put in
# RATE_APP_REFRESH_HOUR. Pakistan is UTC+5, so the host hour that equals
# midnight in Chakwal is 19 UTC -- and because the scheduler anchors on the
# calendar date as well, no single host-clock value can express it cleanly.
# Stating the zone is both simpler and correct. On a Pakistan laptop the result
# is bit-for-bit what it always was.
#
# The offset is written as a fixed +05:00 rather than a named zone on purpose.
# `ZoneInfo("Asia/Karachi")` raises ZoneInfoNotFoundError on a host with no IANA
# database installed (Windows without the `tzdata` package, some slim images),
# and that would be a crash on boot for what is only a scheduling detail.
# Pakistan has observed UTC+5 with no daylight saving since 2009, so a fixed
# offset is not a simplification that can drift.
# ---------------------------------------------------------------------------
PAKISTAN_TZ = timezone(timedelta(hours=5), "PKT")

REFRESH_HOUR = _env_int("RATE_APP_REFRESH_HOUR", 0, 0, 23)
REFRESH_MINUTE = _env_int("RATE_APP_REFRESH_MINUTE", 0, 0, 59)


_REFRESH: dict[str, Any] = {
    "running": False,
    "last_started": None,
    "last_finished": None,
    "last_ok": None,
    "duration_s": None,
    "mouzas": 0,
    "lists": 0,
    "khasras": 0,
    "failures": 0,
    "last_error": None,
    "next_run": None,
}


def _next_midnight(now: datetime | None = None) -> datetime:
    """Next REFRESH_HOUR:REFRESH_MINUTE in Pakistan time, in host-local terms.

    The target is chosen on the Pakistan calendar and then converted back to the
    host's own clock, because the return value is used to measure a sleep and
    a sleep has to be measured in the clock that is actually ticking. On a
    Pakistan laptop the conversion is a no-op and this is exactly the function it
    always was; on a UTC container it lands on the same moment in Chakwal
    instead of five hours later.
    """
    now = now or datetime.now()
    now_pk = now.astimezone(PAKISTAN_TZ)
    target_pk = now_pk.replace(
        hour=REFRESH_HOUR, minute=REFRESH_MINUTE, second=0, microsecond=0
    )
    if target_pk <= now_pk:
        target_pk += timedelta(days=1)
    # to local, then drop the offset: the rest of the app keeps naive local
    # datetimes throughout (see _stale and the last_ok timestamps).
    return target_pk.astimezone().replace(tzinfo=None)


def _next_midnight_display(target: datetime) -> str:
    """The scheduled time as the user should read it, i.e. Pakistan wall time.

    `next_run` is shown verbatim in the footer. On a UTC container the host-local
    string for a midnight-in-Chakwal refresh is "19:00", which reads as seven in
    the evening to anyone in Chakwal. Reporting it on the Pakistan clock means
    the footer says the same thing on the laptop and in the container.
    """
    return (
        target.astimezone(PAKISTAN_TZ)
        .replace(tzinfo=None)
        .isoformat(timespec="seconds")
    )


def refresh_status() -> dict[str, Any]:
    """Snapshot of the nightly job, for the UI and /api/refresh."""
    status = dict(_REFRESH)
    if SERVERLESS:
        # Report the truth rather than a schedule that will never fire. The UI
        # keys its warning colour off `schedule`, so leaving the midnight wording
        # in place would have the footer promising a refresh that cannot happen.
        status["schedule"] = "disabled on this deployment (serverless)"
        status["next_run"] = None
        status["next_run_in_s"] = None
    else:
        nxt = _next_midnight()
        status["next_run"] = _next_midnight_display(nxt)
        status["next_run_in_s"] = max(0, int((nxt - datetime.now()).total_seconds()))
        status["schedule"] = (
            f"{REFRESH_HOUR:02d}:{REFRESH_MINUTE:02d} Pakistan time, daily"
        )
    # Rates are never cached beyond the single request they were made for.
    status["rates_cached"] = False
    return status


async def refresh_reference_data() -> dict[str, Any]:
    """Re-read every reference list in the tehsil, bypassing the cache.

    Never raises: a portal outage has to leave the previous lists in place and
    be reported, not take the app down with it. Individual failures are counted
    and the walk continues, so one bad mouza does not cost the other 225.
    """
    if _REFRESH["running"]:
        return refresh_status()

    limiter = _get_limiter()
    started = time.monotonic()
    _REFRESH.update(
        running=True,
        last_started=datetime.now().isoformat(timespec="seconds"),
        last_error=None,
        failures=0,
        lists=0,
        khasras=0,
    )

    async def guarded(coro):
        # Every portal call the job makes shares the same ceiling as a user's
        # bulk run, so a refresh happening to coincide with an 8,768-Khasra
        # lookup still cannot exceed BATCH_CONCURRENCY against the portal --
        # and the refresh yields the slots to the user rather than the other
        # way round.
        async with limiter.slot(user=False):
            return await coro

    try:
        mouzas = await guarded(
            govapi.mouzas_by_tehsil(TEHSIL_ID, force=True)
        )
        _REFRESH["mouzas"] = len(mouzas)
        log.info("refresh: %d mouzas", len(mouzas))

        async def walk(m: dict[str, Any]) -> None:
            mid, qid, name = m["id"], m["qanoongo_id"], m["name"]
            try:
                classes = await guarded(
                    govapi.rural_land_classifications(
                        mouza_id=mid, qanoongo_id=qid, mouza_name=name, force=True
                    )
                )
            except Exception as exc:  # noqa: BLE001 - one mouza, keep going
                _REFRESH["failures"] += 1
                log.warning("refresh %s classifications: %s", name, exc)
                return
            for lc in classes:
                try:
                    locations = await guarded(
                        govapi.rural_locations(
                            mouza_id=mid,
                            qanoongo_id=qid,
                            mouza_name=name,
                            land_classification_id=lc["id"],
                            force=True,
                        )
                    )
                except Exception as exc:  # noqa: BLE001
                    _REFRESH["failures"] += 1
                    log.warning("refresh %s/%s locations: %s", name, lc["name"], exc)
                    continue
                for loc in locations:
                    try:
                        numbers = await guarded(
                            govapi.rural_khasras(
                                mouza_id=mid,
                                qanoongo_id=qid,
                                mouza_name=name,
                                land_classification_id=lc["id"],
                                location=loc["name"],
                                force=True,
                            )
                        )
                    except Exception as exc:  # noqa: BLE001
                        _REFRESH["failures"] += 1
                        log.warning(
                            "refresh %s/%s/%s: %s", name, lc["name"], loc["name"], exc
                        )
                        continue
                    _REFRESH["lists"] += 1
                    _REFRESH["khasras"] += len(numbers)

        await asyncio.gather(*(walk(m) for m in mouzas))
    except Exception as exc:  # noqa: BLE001 - the whole pass failed
        _REFRESH["last_error"] = f"{type(exc).__name__}: {exc}"
        log.warning("refresh pass failed: %s", exc)
    finally:
        _REFRESH.update(
            running=False,
            last_finished=datetime.now().isoformat(timespec="seconds"),
            duration_s=round(time.monotonic() - started, 1),
        )
        # A pass is only "ok" if it actually walked something and nothing blew
        # up. A portal outage must not overwrite a previous good timestamp.
        if _REFRESH["last_error"] is None and _REFRESH["lists"] > 0:
            _REFRESH["last_ok"] = _REFRESH["last_finished"]
        log.info(
            "refresh done: %d lists, %d khasras, %d failures in %ss",
            _REFRESH["lists"],
            _REFRESH["khasras"],
            _REFRESH["failures"],
            _REFRESH["duration_s"],
        )
    return refresh_status()


_refresh_task: asyncio.Task | None = None


def _start_refresh() -> dict[str, Any]:
    """Claim the run slot synchronously, then spawn the walk.

    The claim has to happen before the task is created, because a fresh task
    does not run until the event loop yields -- without this, two clicks in the
    same tick would both see running=False and both start a pass.
    """
    global _refresh_task
    if _REFRESH["running"] or (_refresh_task and not _refresh_task.done()):
        return refresh_status()
    _refresh_task = asyncio.create_task(refresh_reference_data())
    return refresh_status()


async def _refresh_loop() -> None:
    """Refresh at midnight, and catch up on boot if today's pass was missed."""
    if SERVERLESS:
        # There is no midnight to aim at. A serverless instance is created per
        # request and discarded after it, so a scheduled pass has nothing to
        # survive until, and the boot-time catch-up below would fire on every
        # single cold start -- roughly 2,300 portal calls each time. That is the
        # opposite of what this job exists to do.
        #
        # The reference lists are still cached; they simply live and die with
        # their instance. `refresh_status()` says so rather than reporting a
        # schedule that will never run.
        log.info("serverless mode: nightly reference refresh is disabled")
        return
    # If the machine was off at midnight, or this is the first run ever, do a
    # pass now rather than leaving the lists to expire lazily.
    last_ok = _REFRESH["last_ok"]
    if last_ok is None or _stale(last_ok):
        try:
            await refresh_reference_data()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("startup refresh: %s", exc)

    while True:
        delay = max(1.0, (_next_midnight() - datetime.now()).total_seconds())
        _REFRESH["next_run"] = _next_midnight_display(_next_midnight())
        log.info("next reference refresh in %.0f s", delay)
        await asyncio.sleep(delay)
        try:
            await refresh_reference_data()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            # A failed pass must not kill the loop; tomorrow is another chance.
            log.warning("scheduled refresh: %s", exc)


def _stale(last_ok: str) -> bool:
    """True if the last good pass is older than one refresh cycle."""
    try:
        when = datetime.fromisoformat(last_ok)
    except (TypeError, ValueError):
        return True
    return datetime.now() - when >= timedelta(days=1)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if not SERVERLESS:
        _init_db()
    task = asyncio.create_task(_refresh_loop())
    try:
        yield
    finally:
        task.cancel()
        # Let the cancellation land so the httpx client is not torn down from
        # under an in-flight portal read.
        await asyncio.gather(task, return_exceptions=True)
        await govapi.aclose()


app = FastAPI(
    title=f"{TEHSIL_NAME} DC Rate Calculator",
    description=(
        f"Unofficial local calculator for DC land rates in {SCOPE_LABEL}. "
        "Not affiliated with the Government of the Punjab."
    ),
    version="1.1.0",
    lifespan=lifespan,
)


# --------------------------------------------------------------------------
# History store (local SQLite, for the user's own records)
# --------------------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS lookups (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
    land_type            TEXT,
    district             TEXT,
    tehsil               TEXT,
    scope                TEXT,
    mouza                TEXT,
    property_area        TEXT,
    land_classification  TEXT,
    location             TEXT,
    parcel               TEXT,
    rate                 REAL,
    rate_unit            TEXT,
    per_sqft             REAL,
    area                 REAL,
    area_unit            TEXT,
    land_value           REAL
);
"""


def _init_db() -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(_SCHEMA)


def _rows_to_dicts(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(row) for row in rows]


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

async def _call(coro) -> Any:
    """Run a portal lookup, converting portal failures into 502s."""
    try:
        return await coro
    except govapi.PortalError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def _require(value: Any, label: str) -> Any:
    if value in (None, ""):
        raise HTTPException(status_code=400, detail=f"{label} is required.")
    return value


# --------------------------------------------------------------------------
# Area units
# --------------------------------------------------------------------------

class AreaConvertRequest(BaseModel):
    value: float
    from_unit: Literal["Acre", "Kanal", "Marla", "SqFt"]
    to_unit: Literal["Acre", "Kanal", "Marla", "SqFt"]
    acre_to_kanal: str = Field(default="8", pattern="^(8|9\\.65|9\\.8)$")
    marla_to_sqft: str = Field(default="272", pattern="^(272|225)$")


@app.get("/api/units")
async def units() -> dict[str, Any]:
    """Unit vocabulary and conversion constants (mirrors official calculator)."""
    return {
        "area_units": list(govapi.AREA_UNITS),
        "acre_to_kanal": govapi.ACRE_TO_KANAL,
        "kanal_to_marla": govapi.KANAL_TO_MARLA,
        "marla_to_sqft": govapi.MARLA_TO_SQFT,
    }


@app.post("/api/convert")
async def convert_area(req: AreaConvertRequest) -> dict[str, Any]:
    converted = govapi.convert_area(
        req.value,
        req.from_unit,
        req.to_unit,
        acre_to_kanal=req.acre_to_kanal,
        marla_to_sqft=req.marla_to_sqft,
    )
    return {
        "input": req.value,
        "from_unit": req.from_unit,
        "to_unit": req.to_unit,
        "value": govapi.round_area(converted),
    }


# --------------------------------------------------------------------------
# Location reference data
# --------------------------------------------------------------------------

@app.get("/api/districts")
async def api_districts() -> list[dict[str, Any]]:
    """All Punjab districts. Kept for reference; the UI is pinned to one."""
    return await _call(govapi.districts())


@app.get("/api/scope")
async def api_scope() -> dict[str, Any]:
    """The single district and tehsil this calculator is scoped to."""
    return {
        "district": {"id": DISTRICT_ID, "name": DISTRICT_NAME},
        "tehsil": {"id": TEHSIL_ID, "name": TEHSIL_NAME},
        "label": SCOPE_LABEL,
        "refresh": refresh_status(),
        # The client reads this to know that queued bulk runs are unavailable
        # and that the nightly refresh is not running, so it can adjust what it
        # offers instead of offering something that will fail.
        "serverless": SERVERLESS,
    }


@app.get("/api/refresh")
async def api_refresh() -> dict[str, Any]:
    """State of the nightly reference refresh, including the last failure."""
    return refresh_status()


@app.post("/api/refresh")
async def api_refresh_now() -> dict[str, Any]:
    """Start a reference refresh now instead of waiting for midnight.

    Returns as soon as the pass is claimed rather than waiting it out: a full
    walk is ~5.7 minutes, which is far longer than any client will hold a
    request open. Poll GET /api/refresh for progress.

    Only re-reads the lists -- no rate is fetched, so this stays in the cheap
    bracket regardless of how big the tehsil is.
    """
    if SERVERLESS:
        # Even a manual trigger cannot work: the walk takes ~5 minutes, and the
        # instance running it is discarded long before it finishes. Saying so is
        # better than accepting the click and quietly losing the result.
        raise HTTPException(
            status_code=501,
            detail=(
                "Reference refresh is disabled on this deployment. Lists are "
                "re-read on demand instead, when you open a Mouza."
            ),
        )
    return _start_refresh()


@app.get("/api/tehsils")
async def api_tehsils(
    district_id: int = Query(..., alias="districtId"),
) -> list[dict[str, Any]]:
    """Tehsils of a district, but only the one this calculator serves.

    The district is checked too, so the endpoint cannot be used as a general
    district/tehsil browser.
    """
    if district_id != DISTRICT_ID:
        raise HTTPException(
            status_code=400,
            detail=(
                f"This calculator is scoped to {SCOPE_LABEL}. "
                "Change DISTRICT_ID / TEHSIL_ID in app.py to widen it."
            ),
        )
    return [{"id": TEHSIL_ID, "name": TEHSIL_NAME}]


@app.get("/api/towns")
async def api_towns(tehsil_id: int = Query(..., alias="tehsilId")) -> list[dict[str, Any]]:
    return await _call(govapi.towns(tehsil_id))


@app.get("/api/revenue-circles")
async def api_revenue_circles(
    tehsil_id: int = Query(..., alias="tehsilId"), town: str = Query(...)
) -> list[dict[str, Any]]:
    return await _call(govapi.revenue_circles(tehsil_id, town))


@app.get("/api/floors")
async def api_floors(
    revenue_circle_id: int = Query(..., alias="revenueCircleId")
) -> list[dict[str, Any]]:
    return await _call(govapi.floors(revenue_circle_id))


@app.get("/api/property-areas")
async def api_property_areas(
    tehsil_id: int = Query(..., alias="tehsilId"),
    town: str = Query(...),
    revenue_circle_id: int = Query(..., alias="revenueCircleId"),
) -> list[dict[str, Any]]:
    return await _call(govapi.property_areas(tehsil_id, town, revenue_circle_id))


@app.get("/api/qanoongoes")
async def api_qanoongoes(tehsil_id: int = Query(..., alias="tehsilId")) -> list[dict[str, Any]]:
    return await _call(govapi.qanoongoes(tehsil_id))


@app.get("/api/mouzas")
async def api_mouzas(
    qanoongo_id: int | None = Query(None, alias="qanoongoId"),
    tehsil_id: int | None = Query(None, alias="tehsilId"),
) -> list[dict[str, Any]]:
    """Mouzas, either for one Qanoongoee or for the whole tehsil.

    The tehsil-wide form exists so the UI can offer every Mouza directly and
    fill in the Qanoongoee itself, rather than making you walk the Qanoongoee
    list first to reach any of the 226.
    """
    if qanoongo_id is not None:
        return await _call(govapi.mouzas(qanoongo_id))
    if tehsil_id is not None:
        return await _call(govapi.mouzas_by_tehsil(tehsil_id))
    raise HTTPException(
        status_code=400, detail="Pass either qanoongoId or tehsilId."
    )


@app.get("/api/rural/land-classifications")
async def api_rural_land_classifications(
    mouza_id: int = Query(..., alias="mouzaId"),
    qanoongo_id: int = Query(..., alias="qanoongoId"),
    mouza_name: str = Query(..., alias="mouzaName"),
) -> list[dict[str, Any]]:
    return await _call(
        govapi.rural_land_classifications(
            mouza_id=mouza_id, qanoongo_id=qanoongo_id, mouza_name=mouza_name
        )
    )


@app.get("/api/rural/locations")
async def api_rural_locations(
    mouza_id: int = Query(..., alias="mouzaId"),
    qanoongo_id: int = Query(..., alias="qanoongoId"),
    mouza_name: str = Query(..., alias="mouzaName"),
    land_classification_id: int = Query(..., alias="landClassificationId"),
) -> list[dict[str, Any]]:
    return await _call(
        govapi.rural_locations(
            mouza_id=mouza_id,
            qanoongo_id=qanoongo_id,
            mouza_name=mouza_name,
            land_classification_id=land_classification_id,
        )
    )


@app.get("/api/rural/khasras")
async def api_rural_khasras(
    mouza_id: int = Query(..., alias="mouzaId"),
    qanoongo_id: int = Query(..., alias="qanoongoId"),
    mouza_name: str = Query(..., alias="mouzaName"),
    land_classification_id: int | None = Query(None, alias="landClassificationId"),
    location: str = Query(""),
) -> list[dict[str, Any]]:
    return await _call(
        govapi.rural_khasras(
            mouza_id=mouza_id,
            qanoongo_id=qanoongo_id,
            mouza_name=mouza_name,
            land_classification_id=land_classification_id,
            location=location,
        )
    )


@app.get("/api/rural/square-nos")
async def api_rural_square_nos(
    mouza_id: int = Query(..., alias="mouzaId"),
    qanoongo_id: int = Query(..., alias="qanoongoId"),
    mouza_name: str = Query(..., alias="mouzaName"),
    land_classification_id: int | None = Query(None, alias="landClassificationId"),
    location: str = Query(""),
) -> list[dict[str, Any]]:
    return await _call(
        govapi.rural_square_nos(
            mouza_id=mouza_id,
            qanoongo_id=qanoongo_id,
            mouza_name=mouza_name,
            land_classification_id=land_classification_id,
            location=location,
        )
    )


@app.get("/api/rural/qila-nos")
async def api_rural_qila_nos(
    mouza_id: int = Query(..., alias="mouzaId"),
    qanoongo_id: int = Query(..., alias="qanoongoId"),
    mouza_name: str = Query(..., alias="mouzaName"),
    land_classification_id: int | None = Query(None, alias="landClassificationId"),
    location: str = Query(""),
    square_no: str = Query(..., alias="squareNo"),
) -> list[dict[str, Any]]:
    return await _call(
        govapi.rural_qila_nos(
            mouza_id=mouza_id,
            qanoongo_id=qanoongo_id,
            mouza_name=mouza_name,
            land_classification_id=land_classification_id,
            location=location,
            square_no=square_no,
        )
    )


@app.get("/api/urban/land-classifications")
async def api_urban_land_classifications(
    tehsil_id: int = Query(..., alias="tehsilId"),
    town: str = Query(...),
    revenue_circle_id: int = Query(..., alias="revenueCircleId"),
    property_area_id: int = Query(..., alias="propertyAreaId"),
    property_area_name: str = Query("", alias="propertyAreaName"),
    khasra_no: str = Query("", alias="khasraNo"),
    square_no_id: int | None = Query(None, alias="squareNoId"),
    qila_no: str = Query("", alias="qilaNo"),
) -> list[dict[str, Any]]:
    return await _call(
        govapi.urban_land_classifications(
            tehsil_id=tehsil_id,
            town=town,
            revenue_circle_id=revenue_circle_id,
            property_area_id=property_area_id,
            property_area_name=property_area_name,
            khasra_no=khasra_no,
            square_no_id=square_no_id,
            qila_no=qila_no,
        )
    )


@app.get("/api/urban/locations")
async def api_urban_locations(
    tehsil_id: int = Query(..., alias="tehsilId"),
    town: str = Query(...),
    revenue_circle_id: int = Query(..., alias="revenueCircleId"),
    property_area_id: int = Query(..., alias="propertyAreaId"),
    land_classification_id: int = Query(..., alias="landClassificationId"),
    khasra_no: str = Query("", alias="khasraNo"),
    square_no: str = Query("", alias="squareNo"),
    qila_no: str = Query("", alias="qilaNo"),
) -> list[dict[str, Any]]:
    return await _call(
        govapi.urban_locations(
            tehsil_id=tehsil_id,
            town=town,
            revenue_circle_id=revenue_circle_id,
            property_area_id=property_area_id,
            land_classification_id=land_classification_id,
            khasra_no=khasra_no,
            square_no=square_no,
            qila_no=qila_no,
        )
    )


@app.get("/api/urban/availability")
async def api_urban_availability(
    tehsil_id: int = Query(..., alias="tehsilId"),
    town: str = Query(...),
    revenue_circle_id: int = Query(..., alias="revenueCircleId"),
    property_area_id: int = Query(..., alias="propertyAreaId"),
) -> dict[str, bool]:
    return await _call(
        govapi.urban_availability(
            tehsil_id=tehsil_id,
            town=town,
            revenue_circle_id=revenue_circle_id,
            property_area_id=property_area_id,
        )
    )


@app.get("/api/urban/khasras")
async def api_urban_khasras(
    tehsil_id: int = Query(..., alias="tehsilId"),
    town: str = Query(...),
    revenue_circle_id: int = Query(..., alias="revenueCircleId"),
    property_area_id: int = Query(..., alias="propertyAreaId"),
) -> list[dict[str, Any]]:
    return await _call(
        govapi.urban_khasras(
            tehsil_id=tehsil_id,
            town=town,
            revenue_circle_id=revenue_circle_id,
            property_area_id=property_area_id,
        )
    )


@app.get("/api/urban/square-nos")
async def api_urban_square_nos(
    tehsil_id: int = Query(..., alias="tehsilId"),
    town: str = Query(...),
    revenue_circle_id: int = Query(..., alias="revenueCircleId"),
    property_area_id: int = Query(..., alias="propertyAreaId"),
) -> list[dict[str, Any]]:
    return await _call(
        govapi.urban_square_nos(
            tehsil_id=tehsil_id,
            town=town,
            revenue_circle_id=revenue_circle_id,
            property_area_id=property_area_id,
        )
    )


@app.get("/api/urban/qila-nos")
async def api_urban_qila_nos(
    tehsil_id: int = Query(..., alias="tehsilId"),
    town: str = Query(...),
    revenue_circle_id: int = Query(..., alias="revenueCircleId"),
    property_area_id: int = Query(..., alias="propertyAreaId"),
    square_no_id: int = Query(..., alias="squareNoId"),
) -> list[dict[str, Any]]:
    return await _call(
        govapi.urban_qila_nos(
            tehsil_id=tehsil_id,
            town=town,
            revenue_circle_id=revenue_circle_id,
            property_area_id=property_area_id,
            square_no_id=square_no_id,
        )
    )


# --------------------------------------------------------------------------
# Rate lookup
# --------------------------------------------------------------------------

class RateRequest(BaseModel):
    land_type: Literal["rural", "urban"]
    path: Literal["khasra", "qila", "area"]
    district_id: int | None = None

    district_name: str = ""
    tehsil_name: str = ""
    tehsil_id: int | None = None
    mouza_id: int | None = None
    qanoongo_id: int | None = None
    mouza_name: str = ""
    property_area_id: int | None = None
    property_area_name: str = ""
    revenue_circle_id: int | None = None
    land_classification_id: int | None = None
    land_classification_name: str = ""
    location: str = ""

    khasra_no: str = ""
    square_no: str = ""
    square_no_id: int | None = None
    qila_no: str = ""

    town: str = ""
    floor_id: int | None = None

    # Valuation
    area: float = Field(default=1.0, gt=0)
    area_unit: Literal["Acre", "Kanal", "Marla", "SqFt"] = "Marla"
    acre_to_kanal: str = Field(default="8", pattern="^(8|9\\.65|9\\.8)$")
    marla_to_sqft: str = Field(default="272", pattern="^(272|225)$")

    # Context to store alongside a saved history row.
    save: bool = False
    scope: str = ""


def _enforce_scope(req: RateRequest) -> None:
    """This build serves one tehsil. Reject anything else, don't answer it.

    Shared by the single and bulk endpoints so neither can be used as a general
    Punjab rate oracle.
    """
    if req.district_id is not None and req.district_id != DISTRICT_ID:
        raise HTTPException(
            status_code=400,
            detail=(
                f"This calculator is scoped to {SCOPE_LABEL}. "
                "Change DISTRICT_ID in app.py to serve another district."
            ),
        )
    if req.district_name and req.district_name != DISTRICT_NAME:
        raise HTTPException(
            status_code=400,
            detail=f"This calculator is scoped to {SCOPE_LABEL}.",
        )
    if req.tehsil_id is not None and req.tehsil_id != TEHSIL_ID:
        raise HTTPException(
            status_code=400,
            detail=(
                f"This calculator is scoped to {SCOPE_LABEL}. "
                "Change TEHSIL_ID in app.py to serve another tehsil."
            ),
        )
    if req.tehsil_name and req.tehsil_name != TEHSIL_NAME:
        raise HTTPException(
            status_code=400,
            detail=f"This calculator is scoped to {SCOPE_LABEL}.",
        )


def _value_for_rate(rate: dict[str, Any], req: RateRequest) -> dict[str, Any] | None:
    """Value the requested area at a portal rate, or None if there is no rate."""
    if not (rate.get("found") and rate.get("rate") is not None):
        return None

    rate_unit = govapi.canonical_unit(rate.get("unit")) or req.area_unit
    computed = govapi.land_value(
        area=req.area,
        area_unit=req.area_unit,
        rate=rate["rate"],
        rate_unit=rate_unit,
        acre_to_kanal=req.acre_to_kanal,
        marla_to_sqft=req.marla_to_sqft,
    )
    return {
        "area": req.area,
        "area_unit": req.area_unit,
        "area_in_rate_unit": govapi.round_area(computed["area_in_rate_unit"]),
        "rate": rate["rate"],
        "rate_unit": rate_unit,
        "rate_unit_raw": rate.get("unit"),
        "total": computed["total"],
        "total_sqft": govapi.round_area(computed["total_sqft"]),
        "implied_per_sqft": computed["implied_per_sqft"],
        # The portal reports its own per-sqft rate as a separate field.
        # It does not always agree with (marla rate / sq ft per marla), so
        # it is reported as-is rather than treated as the same number.
        "portal_per_sqft": rate.get("per_sqft") or None,
    }


@app.post("/api/rate")
async def api_rate(req: RateRequest) -> dict[str, Any]:
    """Fetch the DC rate for a parcel and value the land at it."""
    _enforce_scope(req)

    if req.land_type == "rural":
        shared = {
            "mouza_id": _require(req.mouza_id, "Mouza"),
            "qanoongo_id": _require(req.qanoongo_id, "Qanoongoee"),
            "mouza_name": req.mouza_name,
            "land_classification_id": req.land_classification_id,
            "location": req.location,
        }
        if req.path == "khasra":
            _require(req.khasra_no, "Khasra number")
            rate = await _call(
                govapi.rate_rural_khasra({**shared, "khasra_no": req.khasra_no})
            )
            parcel = f"Khasra {req.khasra_no}"
        elif req.path == "qila":
            _require(req.square_no, "Square number")
            _require(req.qila_no, "Qila number")
            rate = await _call(
                govapi.rate_rural_qila(
                    {**shared, "square_no": req.square_no, "qila_no": req.qila_no}
                )
            )
            parcel = f"Square {req.square_no} / Qila {req.qila_no}"
        else:
            raise HTTPException(
                status_code=400,
                detail="Rural land is rated by Khasra or by Square/Qila number.",
            )
        scope = "Mouza"
    else:
        shared = {
            "tehsil_id": _require(req.tehsil_id, "Tehsil"),
            "town": req.town,
            "revenue_circle_id": _require(req.revenue_circle_id, "Revenue Circle"),
            "property_area_id": _require(req.property_area_id, "Property Area"),
            "property_area_name": req.property_area_name,
            "land_classification_id": req.land_classification_id,
            "floor_id": req.floor_id,
            "location": req.location,
            "area": req.area,
        }
        if req.path == "khasra":
            _require(req.khasra_no, "Khasra number")
            rate = await _call(
                govapi.rate_urban_khasra({**shared, "khasra_no": req.khasra_no})
            )
            parcel = f"Khasra {req.khasra_no}"
        elif req.path == "qila":
            _require(req.square_no, "Square number")
            _require(req.qila_no, "Qila number")
            rate = await _call(
                govapi.rate_urban_qila(
                    {**shared, "square_no": req.square_no, "qila_no": req.qila_no}
                )
            )
            parcel = f"Square {req.square_no} / Qila {req.qila_no}"
        elif req.path == "area":
            rate = await _call(govapi.rate_urban_area(shared))
            parcel = f"Property Area {req.property_area_name}".strip()
        else:
            raise HTTPException(status_code=400, detail="Unknown valuation path.")
        scope = "Property Area"

    # Value the land. Only possible once we have a numeric rate and a unit.
    value = _value_for_rate(rate, req)

    # Why there is no rate. Wording has to follow the chain: a rural Khasra and
    # an urban property area are different things, and telling the reader to
    # check "the Khasra/Square number" for a property area -- which has neither
    # -- sends them off to look for a field that does not exist.
    if rate.get("found"):
        message = None
    elif req.land_type == "urban":
        message = (
            "The official portal has no DC rate recorded for this property "
            "area. It is either not yet rated, or it is rated under a different "
            "town, revenue circle or floor."
        )
    else:
        message = (
            "The official portal has no DC rate recorded for this Khasra. This "
            "usually means the Khasra number is wrong, or the parcel is not yet "
            "rated for the selected classification."
        )

    result = {
        "found": bool(rate.get("found")),
        "rate": rate,
        "value": value,
        "parcel": parcel,
        "scope": scope,
        "source": govapi.OFFICIAL_BASE,
        "message": message,
    }

    if req.save and value:
        _save_lookup(req, value, parcel, scope)

    return result


# --------------------------------------------------------------------------
# Bulk Khasra rates
# --------------------------------------------------------------------------

class BatchRateRequest(RateRequest):
    """Same context as a single lookup, but a list of Khasra numbers."""

    # path is pinned to "khasra" below; a batch of Square/Qila pairs is not a
    # thing the portal supports and would need N more identifiers per row.
    khasras: list[str] = Field(default_factory=list)


def _prepare_batch(
    req: BatchRateRequest,
) -> tuple[list[str], dict[str, Any]]:
    """Validate a batch and return its numbers plus the shared lookup scope.

    Split out from the run so the synchronous and the queued path enforce
    identical rules and return identical errors -- a queued batch must not be a
    laxer path around the guards.
    """
    _enforce_scope(req)

    if req.land_type != "rural" or req.path != "khasra":
        raise HTTPException(
            status_code=400,
            detail="Bulk lookup is available for rural Khasras only.",
        )

    # De-duplicate while preserving the order the user picked them in, and drop
    # blanks, so a double-click cannot double the load on the portal.
    numbers: list[str] = []
    seen: set[str] = set()
    for raw in req.khasras:
        number = str(raw).strip()
        if not number or number in seen:
            continue
        seen.add(number)
        numbers.append(number)

    if not numbers:
        raise HTTPException(status_code=400, detail="Select at least one Khasra.")
    if len(numbers) > BATCH_CEILING:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{len(numbers)} Khasras in one request; the ceiling is "
                f"{BATCH_CEILING}. The largest list in the tehsil is 8,768, so a "
                "request this size is a bug, not a selection."
            ),
        )

    shared = {
        "mouza_id": _require(req.mouza_id, "Mouza"),
        "qanoongo_id": _require(req.qanoongo_id, "Qanoongoee"),
        "mouza_name": req.mouza_name,
        "land_classification_id": req.land_classification_id,
        "location": req.location,
    }
    return numbers, shared


async def _run_batch(
    req: BatchRateRequest,
    numbers: list[str],
    shared: dict[str, Any],
    on_progress: Any = None,
) -> dict[str, Any]:
    """Fetch every rate and shape the response envelope.

    Partial results are returned rather than failing the batch: a Khasra with
    no published rate is a normal outcome, not an error.
    """
    limiter = _get_limiter()
    done = 0

    async def one(number: str) -> dict[str, Any]:
        nonlocal done
        async with limiter.slot(user=True):
            try:
                rate = await govapi.rate_rural_khasra(
                    {**shared, "khasra_no": number}
                )
            except govapi.PortalError as exc:
                # One unreachable Khasra should not sink the other 99.
                row = {"khasra": number, "found": False, "value": None,
                       "rate": None, "rate_unit": None, "error": str(exc)}
            else:
                value = _value_for_rate(rate, req)
                row = {
                    "khasra": number,
                    "found": bool(value),
                    "value": value,
                    "rate": rate.get("rate"),
                    "rate_unit": (value or {}).get("rate_unit") or rate.get("unit"),
                    "error": None if value else "no_rate",
                }
        done += 1
        if on_progress is not None:
            on_progress(done)
        return row

    results = await asyncio.gather(*(one(n) for n in numbers))

    rated = [r for r in results if r["found"]]
    rates = [r["value"]["rate"] for r in rated]
    distinct = sorted({round(rate, 6) for rate in rates})

    summary = {
        "requested": len(numbers),
        "rated": len(rated),
        "unrated": len(results) - len(rated),
        "distinct_rate_count": len(distinct),
        "all_same_rate": len(distinct) <= 1 and bool(rated),
        "min_rate": min(rates) if rates else None,
        "max_rate": max(rates) if rates else None,
        # Rate units can differ between Khasras of one Mouza, so the total is
        # only meaningful when they all share a unit.
        "rate_unit": (rated[0]["rate_unit"] if rated else None),
        "units_differ": len({r["rate_unit"] for r in rated}) > 1,
        "total_value": (
            sum(r["value"]["total"] for r in rated)
            if rated and len({r["rate_unit"] for r in rated}) == 1
            else None
        ),
    }

    return {
        "count": len(results),
        "results": results,
        "summary": summary,
        "area": {
            "area": req.area,
            "area_unit": req.area_unit,
            "acre_to_kanal": req.acre_to_kanal,
            "marla_to_sqft": req.marla_to_sqft,
        },
        "mouza": req.mouza_name,
        "land_classification": req.land_classification_name,
        "location": req.location,
        "source": govapi.OFFICIAL_BASE,
    }


@app.post("/api/rates/batch")
async def api_rates_batch(req: BatchRateRequest) -> dict[str, Any]:
    """DC rate for many Khasras at the same Mouza/classification/location.

    The portal has no bulk endpoint -- its own multi-Khasra screen also issues
    one request per Khasra -- so this is N lookups run a few at a time. There
    is no cap on N.

    This waits for the whole batch, which is fine for a few hundred Khasras but
    not for 8,768 (~65s, and longer behind a hosting proxy). Big runs should use
    /api/rates/batch/async, which hands the work to a server-side job and
    returns immediately.
    """
    numbers, shared = _prepare_batch(req)
    return await _run_batch(req, numbers, shared)


# ---- Queued batches -------------------------------------------------------
#
# A bulk run of the largest mouza takes ~65s cold. Hosting platforms cut HTTP
# requests off well before that -- nginx defaults to 60s, Render to 100s -- so a
# synchronous batch fails with a gateway timeout even though the server is
# working perfectly. A queued run finishes the work regardless of how long the
# client connection survives, and the client polls for progress.

JOB_TTL_S = 30 * 60        # keep a finished job's results this long
JOB_MAX_LIVE = 64          # memory bound, not a usage limit


class _BatchJob:
    """One bulk run, held server-side so it outlives the request that made it."""

    __slots__ = ("id", "total", "done", "status", "error", "result",
                 "created", "finished", "_req", "_numbers", "_shared")

    def __init__(
        self, job_id: str, req: BatchRateRequest,
        numbers: list[str], shared: dict[str, Any],
    ) -> None:
        self.id = job_id
        self.total = len(numbers)
        self.done = 0
        self.status = "running"
        self.error: str | None = None
        self.result: dict[str, Any] | None = None
        self.created = time.monotonic()
        self.finished: float | None = None
        self._req = req
        self._numbers = numbers
        self._shared = shared

    async def run(self) -> None:
        try:
            self.result = await _run_batch(
                self._req, self._numbers, self._shared,
                on_progress=lambda n: setattr(self, "done", n),
            )
            self.status = "done"
        except asyncio.CancelledError:
            self.status = "cancelled"
            raise
        except Exception as exc:  # noqa: BLE001 - surface it, never 500 silently
            self.status = "error"
            self.error = f"{type(exc).__name__}: {exc}"
        finally:
            self.finished = time.monotonic()

    def payload(self, with_results: bool) -> dict[str, Any]:
        body: dict[str, Any] = {
            "job_id": self.id,
            "status": self.status,
            "done": self.done,
            "total": self.total,
            "elapsed_s": round(
                (self.finished or time.monotonic()) - self.created, 1
            ),
        }
        if self.error:
            body["error"] = self.error
        if self.status == "done" and self.result is not None:
            body["summary"] = self.result["summary"]
            body["mouza"] = self.result["mouza"]
            body["land_classification"] = self.result["land_classification"]
            body["location"] = self.result["location"]
            body["area"] = self.result["area"]
            body["source"] = self.result["source"]
            if with_results:
                body["count"] = self.result["count"]
                body["results"] = self.result["results"]
        return body


def _evict_jobs() -> None:
    """Drop expired results and cap how many are held, oldest first.

    Not an access limit -- just so a long-running public instance cannot grow
    without bound. The portal-facing ceiling is BATCH_CONCURRENCY regardless of
    how many jobs are queued.
    """
    now = time.monotonic()
    for job_id, job in list(JOBS.items()):
        if job.finished is not None and now - job.finished > JOB_TTL_S:
            JOBS.pop(job_id, None)
    if len(JOBS) > JOB_MAX_LIVE:
        finished = sorted(
            (j for j in JOBS.values() if j.finished is not None),
            key=lambda j: j.finished or 0,
        )
        for job in finished[: len(JOBS) - JOB_MAX_LIVE]:
            JOBS.pop(job.id, None)


@app.post("/api/rates/batch/async")
async def api_rates_batch_async(req: BatchRateRequest) -> dict[str, Any]:
    """Start a bulk run and return immediately with a job id.

    Same validation and same work as the synchronous endpoint; the difference is
    only that the client does not have to hold the connection open for a minute.
    """
    if SERVERLESS:
        # A job lives in this process's memory. On a platform that starts a new
        # instance per request, the status poll would be answered by a different
        # instance that has never heard of the job. So say so plainly instead of
        # handing back an id that is guaranteed to 404.
        raise HTTPException(
            status_code=501,
            detail=(
                "Queued bulk runs are not available on this deployment. Run the "
                "batch synchronously via POST /api/rates/batch instead."
            ),
        )
    numbers, shared = _prepare_batch(req)
    _evict_jobs()
    job = _BatchJob(uuid.uuid4().hex, req, numbers, shared)
    JOBS[job.id] = job
    asyncio.create_task(job.run())
    return {"job_id": job.id, "status": job.status, "total": job.total}


@app.get("/api/rates/batch/async/{job_id}")
async def api_rates_batch_status(
    job_id: str, results: bool = Query(True)
) -> dict[str, Any]:
    """Progress for a queued run, and its results once it finishes.

    `results=false` polls cheaply: an 8,768-row payload on every 1s tick would
    be megabytes of JSON re-sent for nothing.
    """
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(
            status_code=404,
            detail=(
                "No such job. It may have finished more than "
                f"{JOB_TTL_S // 60} minutes ago and been cleaned up."
            ),
        )
    return job.payload(with_results=results and job.status == "done")


def _save_lookup(req: RateRequest, value: dict[str, Any], parcel: str, scope: str) -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO lookups (
                land_type, district, tehsil, scope, mouza, property_area,
                land_classification, location, parcel, rate, rate_unit,
                per_sqft, area, area_unit, land_value
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                req.land_type,
                req.district_name,
                req.tehsil_name,
                scope,
                req.mouza_name,
                req.property_area_name,
                req.land_classification_name,
                req.location,
                parcel,
                value["rate"],
                value["rate_unit"],
                value.get("portal_per_sqft") or value.get("implied_per_sqft"),
                value["area"],
                value["area_unit"],
                value["total"],
            ),
        )


# --------------------------------------------------------------------------
# History
#
# Nothing has written to this table for a long time -- bulk results are not
# stored, and the saved-lookup table was removed. These endpoints remain so a
# local install keeps behaving the way it always has, but on a serverless
# deployment they answer empty rather than touching the filesystem: the bundled
# image is read-only or ephemeral, and a missing SQLite file should never be able
# to turn into a 500 on a request that does not need history at all.
# --------------------------------------------------------------------------

def _history_db():
    """Open the history database, or None where there is no usable filesystem."""
    if SERVERLESS:
        return None
    try:
        return sqlite3.connect(DB_PATH)
    except sqlite3.Error:
        return None


@app.get("/api/history")
async def api_history(limit: int = Query(200, ge=1, le=2000)) -> list[dict[str, Any]]:
    conn = _history_db()
    if conn is None:
        return []
    with conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM lookups ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return _rows_to_dicts(rows)


@app.delete("/api/history/{lookup_id}")
async def api_history_delete(lookup_id: int) -> dict[str, Any]:
    conn = _history_db()
    if conn is None:
        return {"deleted": 0}
    with conn:
        cur = conn.execute("DELETE FROM lookups WHERE id = ?", (lookup_id,))
    return {"deleted": cur.rowcount}


@app.delete("/api/history")
async def api_history_clear() -> dict[str, Any]:
    conn = _history_db()
    if conn is None:
        return {"deleted": 0}
    with conn:
        cur = conn.execute("DELETE FROM lookups")
    return {"deleted": cur.rowcount}


@app.get("/api/history.csv")
async def api_history_csv() -> StreamingResponse:
    conn = _history_db()
    rows: list[dict[str, Any]] = []
    if conn is not None:
        with conn:
            conn.row_factory = sqlite3.Row
            rows = [dict(r) for r in conn.execute(
                "SELECT * FROM lookups ORDER BY id DESC")]

    buffer = io.StringIO()
    if rows:
        writer = csv.DictWriter(buffer, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="dc-rate-lookups.csv"'},
    )


# --------------------------------------------------------------------------
# Deep links into the official portal
# --------------------------------------------------------------------------

@app.get("/api/links")
async def api_links() -> dict[str, Any]:
    """Verified entry points on the official portal, pinned to Chakwal.

    The DC Valuation screen accepts a `districtId` query parameter, which
    preselects and locks the district dropdown - so the hand-off link lands
    straight on Chakwal.
    """
    return {
        "district": {"id": DISTRICT_ID, "name": DISTRICT_NAME},
        "disclaimer": (
            "These links open the official Government of the Punjab portal. "
            "Any challan, stamp duty or registration transaction must be "
            "completed there."
        ),
        "static": [
            {
                "label": "DC Valuation (official)",
                "url": f"{OFFICIAL_DC_VALUATION_URL}&districtId={DISTRICT_ID}",
            },
            {
                "label": "e-Stamping Citizen Portal (home)",
                "url": f"{govapi.OFFICIAL_BASE}/ChallanFormView/HomePage",
            },
            {
                "label": "Challan Form 32-A & AR-17",
                "url": f"{govapi.OFFICIAL_BASE}/ChallanFormView/AddChallan?name=Challan32A",
            },
            {
                "label": "Green Property Certificate challan",
                "url": f"{govapi.OFFICIAL_BASE}/ChallanFormView/GreenPropertyCertificateChallan",
            },
            {
                "label": "Verify / reprint a challan",
                "url": f"{govapi.OFFICIAL_BASE}/ChallanFormView/SearchChallan?name=reprintchallan",
            },
            {
                "label": "Verify e-Stamps",
                "url": f"{govapi.OFFICIAL_BASE}/ChallanFormView/VerifyStamp?name=verifystamp",
            },
            {
                "label": "Stamp number retrieval",
                "url": f"{govapi.OFFICIAL_BASE}/Stamp/StampRetrieval?name=stampretrieval",
            },
            {
                "label": "Download stamp paper",
                "url": f"{govapi.OFFICIAL_BASE}/Stamp/SearchChallan?name=whitepaper",
            },
            {
                "label": "Help / FAQs",
                "url": f"{govapi.OFFICIAL_BASE}/ChallanFormView/HelpFAQs",
            },
            {
                "label": "e-Registration (create a deed)",
                "url": "https://eregistration.punjab-zameen.gov.pk",
            },
        ],
        "dc_valuation_template": OFFICIAL_DC_VALUATION_URL,
        "dc_valuation_with_district": OFFICIAL_DC_VALUATION_URL + "&districtId={districtId}",
    }


# --------------------------------------------------------------------------
# Static frontend
# --------------------------------------------------------------------------

@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health() -> dict[str, Any]:
    """Liveness probe for a hosting platform.

    Deliberately does not touch the portal: a health check that made a portal
    call every few seconds would be exactly the kind of pointless traffic this
    app is built to avoid. It answers as long as the process can serve.
    """
    return {
        "ok": True,
        "tehsil": TEHSIL_NAME,
        "reference_lists": _REFRESH["last_ok"],
        "refresh_running": _REFRESH["running"],
    }


@app.middleware("http")
async def no_store_static(request, call_next):
    """Never let the browser cache the frontend.

    A stale app.js after a deploy is far more confusing than the handful of
    bytes re-sending it costs -- a user on a phone would otherwise keep running
    yesterday's JavaScript against today's API and see errors that make no
    sense.
    """
    response = await call_next(request)
    if request.url.path.startswith("/static") or request.url.path == "/":
        response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


# --------------------------------------------------------------------------
# Hosting
# --------------------------------------------------------------------------
# Serving this over the internet is one command: uvicorn binds 0.0.0.0:PORT and
# the page is already served at /. Two things are worth knowing before putting it
# on a public URL, and both are enforced or documented below rather than left to
# chance.
#
# 1. Run ONE worker. BATCH_CONCURRENCY is a per-process semaphore, so N workers
#    means N x 4 requests in flight against the portal -- four workers would
#    quietly quadruple the load this app is careful to keep small. The Dockerfile
#    and render.yaml both pin a single worker.
# 2. CORS is off. The page and the API are the same origin, so nothing needs it.
#    Set RATE_APP_CORS_ORIGINS only if you deliberately split the frontend onto
#    a different host -- and then you have opened a public API to that origin.
#
# There is no authentication. This build was chosen to be open, which means
# anyone with the URL can spend this server's portal budget, and the portal sees
# the requests from your host rather than from them. See the README.

_cors_origins = [
    origin.strip()
    for origin in os.environ.get("RATE_APP_CORS_ORIGINS", "").split(",")
    if origin.strip()
]
if _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )


if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

