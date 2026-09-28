"""
govapi.py - read-only client for the Punjab e-Stamping portal's public
land-valuation lookups, plus Punjab land-area unit conversion.

IMPORTANT / DISCLAIMER
---------------------
This module is an UNOFFICIAL, read-only convenience client. It is not
affiliated with, endorsed by, or operated by the Government of the Punjab,
the Board of Revenue, or PLRA. It carries no government branding.

It only reads public rate/location lookups so a person can see a DC rate
faster than the official 7-level form allows. Every number displayed is
fetched live from the official portal at request time; nothing is cached
across restarts and no rate is ever authored or stored here. Any figure
that matters legally (stamp duty, registration, a challan) MUST be taken
from the official portal itself.

All figures come from the official portal, so this file never invents a rate.
"""

from __future__ import annotations

import asyncio
import ssl
import time
from typing import Any, Iterable

import httpx

# --------------------------------------------------------------------------
# Official portal configuration
# --------------------------------------------------------------------------

OFFICIAL_HOST = "https://es.punjab-zameen.gov.pk"
OFFICIAL_BASE = f"{OFFICIAL_HOST}/eStampCitizenPortal"
OFFICIAL_API = f"{OFFICIAL_BASE}/api/Proxy/Locations"

# The portal's gateway rejects requests without a browser-like User-Agent
# (a bare client gets HTTP 500 rather than a helpful error), so send one.
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": f"{OFFICIAL_BASE}/ChallanFormView/RateOfChallanView",
    "Content-Type": "application/json;charset=utf-8",
}

# Sentinel the portal returns instead of an empty list.
_NO_DATA = "no data exist"

# Reference data (mouzas, classifications, locations, Khasra numbers) is
# refreshed on a schedule by the job in app.py rather than by expiring here, so
# this TTL is not the refresh interval -- it is a lease long enough to cover
# one whole cycle, set 25h so a request can never race the midnight job into a
# synchronous refetch and stall the UI. The job re-seeds every entry with
# force=True, so the lease is renewed rather than waited out.
#
# If the job cannot run at all (machine asleep, portal down) entries simply
# expire and the next request refetches them, which is the desired fallback:
# a stale list is worse than a slow one.
_TTL_REFERENCE = 25 * 60 * 60     # 25 hours

# Rates are never pre-fetched or pre-seeded. There are 916,700 distinct Khasra
# rates in this tehsil, and holding them would mean ~117 minutes of continuous
# portal load per pass -- so rates are always fetched on demand, and the only
# thing this TTL does is collapse a repeated lookup of the same Khasra.
_TTL_RATE = 5 * 60            # 5 minutes


class PortalError(RuntimeError):
    """Raised when the official portal cannot answer a lookup."""


# --------------------------------------------------------------------------
# TLS compatibility
# --------------------------------------------------------------------------
# The portal sits behind a gateway that only offers legacy SHA-1 cipher
# suites (e.g. AES256-SHA). OpenSSL 3 rejects those at its default security
# level, which surfaces as a bare "sslv3 alert handshake failure" carrying no
# useful detail. Dropping to SECLEVEL=1 for this one read-only host restores
# the handshake; the connection is still TLS 1.2 encrypted.
#
# This is a compatibility workaround for the portal's outdated TLS config, not
# an endorsement of it. It is scoped to this single host and can be switched
# off with _TLS_LEGACY_COMPAT if the portal ever negotiates a modern suite.
_TLS_LEGACY_COMPAT = True


def _build_ssl_context() -> ssl.SSLContext | bool:
    if not _TLS_LEGACY_COMPAT:
        return True
    context = ssl.create_default_context()
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    try:
        context.set_ciphers("DEFAULT@SECLEVEL=1")
    except ssl.SSLError:
        return True
    return context


# --------------------------------------------------------------------------
# Tiny TTL cache
# --------------------------------------------------------------------------

class _TTLCache:
    def __init__(self) -> None:
        self._store: dict[str, tuple[float, Any]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def get(self, key: str) -> tuple[bool, Any]:
        hit = self._store.get(key)
        if hit is None:
            return False, None
        expires_at, value = hit
        if time.monotonic() >= expires_at:
            self._store.pop(key, None)
            return False, None
        return True, value

    def set(self, key: str, value: Any, ttl: int) -> None:
        self._store[key] = (time.monotonic() + ttl, value)

    def lock(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = self._locks[key] = asyncio.Lock()
        return lock

    def clear(self) -> None:
        self._store.clear()


_cache = _TTLCache()


# --------------------------------------------------------------------------
# Transport
# --------------------------------------------------------------------------

_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            headers=_HEADERS,
            timeout=httpx.Timeout(30.0, connect=15.0),
            follow_redirects=True,
            verify=_build_ssl_context(),
        )
    return _client


async def aclose() -> None:
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None


async def _request(
    endpoint: str,
    params: dict[str, Any] | None = None,
    body: dict[str, Any] | None = None,
    *,
    ttl: int,
    force: bool = False,
) -> Any:
    """POST to an official endpoint, with caching and clear error surfacing.

    The portal's own JS uses POST for every one of these lookups (including
    the plain list ones), so we match that.

    `force` re-reads from the portal and re-seeds the entry instead of
    serving it. Only the nightly reference refresh uses it, so that a refresh
    can genuinely pick up a Khasra the portal added since the last pass rather
    than re-seeding yesterday's cache.
    """
    key = f"{endpoint}|{sorted((params or {}).items())}|{sorted((body or {}).items(), key=str)}"
    if not force:
        hit, value = _cache.get(key)
        if hit:
            return value

    # Collapse concurrent identical lookups into one upstream request. Under
    # force the lock is still taken so a forced read cannot interleave with a
    # normal one and leave two writers on the same key.
    async with _cache.lock(key):
        if not force:
            hit, value = _cache.get(key)
            if hit:
                return value

        url = f"{OFFICIAL_API}/{endpoint.lstrip('/')}"
        client = _get_client()
        try:
            response = await client.post(
                url,
                params=params or None,
                json=body if body is not None else None,
            )
        except httpx.HTTPError as exc:
            raise PortalError(f"Could not reach the official portal: {exc}") from exc

        if response.status_code >= 400:
            raise PortalError(
                f"Official portal returned HTTP {response.status_code} for {endpoint}."
            )

        try:
            parsed = response.json()
        except ValueError:
            raise PortalError(
                f"Official portal sent a non-JSON reply for {endpoint}."
            ) from None

        # Surface the portal's own "no such action" style errors, which come
        # back as HTTP 200 with a Message body.
        if isinstance(parsed, dict) and parsed.get("Message") and "data" not in parsed:
            raise PortalError(str(parsed.get("MessageDetail") or parsed["Message"]))

        _cache.set(key, parsed, ttl)
        return parsed


# --------------------------------------------------------------------------
# Response normalisation
# --------------------------------------------------------------------------

def _norm_items(data: Any, keep: Iterable[str] = ()) -> list[dict[str, Any]]:
    """Turn a portal list into clean {id, name, ...} dicts.

    Drops the "No Data Exist" sentinel the portal uses for empty lookups.
    """
    keep = tuple(keep)
    if not isinstance(data, list):
        return []

    out: list[dict[str, Any]] = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("Name") or "").strip()
        if not name or name.lower() == _NO_DATA:
            continue
        item: dict[str, Any] = {"id": entry.get("Id"), "name": name}
        for field in keep:
            if field in entry:
                item[field] = entry[field]
        out.append(item)
    return out


def _to_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------
# Reference data lookups
# --------------------------------------------------------------------------

async def districts() -> list[dict[str, Any]]:
    data = await _request("AllDistricts", ttl=_TTL_REFERENCE)
    return _norm_items(data)


async def tehsils(district_id: int | str) -> list[dict[str, Any]]:
    data = await _request(
        "TehsilsByDistrictId", params={"Id": district_id}, ttl=_TTL_REFERENCE
    )
    return _norm_items(data)


async def towns(tehsil_id: int | str) -> list[dict[str, Any]]:
    data = await _request(
        "TownByTehsilId", params={"Id": tehsil_id}, ttl=_TTL_REFERENCE
    )
    return _norm_items(data)


async def revenue_circles(tehsil_id: int | str, town: str) -> list[dict[str, Any]]:
    data = await _request(
        "RevenueCircleByTehsilId",
        params={"id": tehsil_id, "town": town},
        ttl=_TTL_REFERENCE,
    )
    return _norm_items(data)


async def floors(revenue_circle_id: int | str) -> list[dict[str, Any]]:
    data = await _request(
        "GetFloors", params={"RevenueCircleId": revenue_circle_id}, ttl=_TTL_REFERENCE
    )
    return _norm_items(data)


async def property_areas(
    tehsil_id: int | str, town: str, revenue_circle_id: int | str
) -> list[dict[str, Any]]:
    data = await _request(
        "PropertyAreaByLandInfo",
        params={
            "TehsilId": tehsil_id,
            "town": town,
            "RevenueCircleId": revenue_circle_id,
        },
        ttl=_TTL_REFERENCE,
    )
    return _norm_items(data)


# ---- Rural (Qanoongoee -> Mouza) -----------------------------------------

async def qanoongoes(
    tehsil_id: int | str, *, force: bool = False
) -> list[dict[str, Any]]:
    data = await _request(
        "QanoongoByTehsilId",
        params={"id": tehsil_id},
        ttl=_TTL_REFERENCE,
        force=force,
    )
    return _norm_items(data)


async def mouzas(
    qanoongo_id: int | str, *, force: bool = False
) -> list[dict[str, Any]]:
    data = await _request(
        "MouzaByLandInfo",
        params={"QanoonGoId": qanoongo_id},
        ttl=_TTL_REFERENCE,
        force=force,
    )
    # The hierarchy flags decide which rate path this Mouza uses.
    return _norm_items(
        data, keep=("IS_KHASRA_HIERARCHY", "IS_SQUARE_NO_HIERARCHY")
    )


async def mouzas_by_tehsil(
    tehsil_id: int | str, *, force: bool = False
) -> list[dict[str, Any]]:
    """Every Mouza in a tehsil, each tagged with the Qanoongoee that owns it.

    The portal has no tehsil-wide Mouza endpoint -- MouzaByTehsilId,
    MouzasByTehsilId, MouzaByDistrictId and AllMouzaByTehsilId all 404 -- so
    this walks the Qanoongoes and merges their lists. Those per-Qanoongoee
    lookups are already cached and the eight requests run concurrently, so the
    whole tehsil costs one round trip to the portal.

    A Mouza row carries no Qanoongoee of its own (id, name and the two
    hierarchy flags are all it returns), so the owner recorded here is the one
    the request was scoped to, not a value copied out of the row.
    """
    qgs = await qanoongoes(tehsil_id, force=force)
    if not qgs:
        return []
    found = await asyncio.gather(
        *(mouzas(qg["id"], force=force) for qg in qgs), return_exceptions=True
    )

    out: list[dict[str, Any]] = []
    for qg, result in zip(qgs, found):
        # One Qanoongoee failing should not cost the user the other seven.
        if isinstance(result, BaseException):
            continue
        for m in result:
            out.append(
                {**m, "qanoongo_id": qg["id"], "qanoongo_name": qg["name"]}
            )
    return out


def _rural_lookup_body(
    *,
    mouza_id: int | str,
    qanoongo_id: int | str,
    land_classification_id: int | str | None,
    location: str,
    mouza_name: str,
) -> dict[str, Any]:
    """Body shape shared by the rural Mouza-scoped endpoints."""
    return {
        "MouzaId": mouza_id,
        "QanoonGoId": qanoongo_id,
        "LandClassificationId": land_classification_id or 0,
        "LocationString": location or "",
        "MouzaName": mouza_name or "",
        "KhasraNo": "",
        "SquareNo": "",
        "QilaNo": "",
    }


async def rural_land_classifications(
    *,
    mouza_id: int | str,
    qanoongo_id: int | str,
    mouza_name: str,
    force: bool = False,
) -> list[dict[str, Any]]:
    body = _rural_lookup_body(
        mouza_id=mouza_id,
        qanoongo_id=qanoongo_id,
        land_classification_id=None,
        location="",
        mouza_name=mouza_name,
    )
    data = await _request(
        "AllLandClassificationsByMouzaName",
        params={
            "MouzaName": mouza_name,
            "QanoonGoId": qanoongo_id,
        },
        body=body,
        ttl=_TTL_REFERENCE,
        force=force,
    )
    return _norm_items(data)


async def rural_locations(
    *,
    mouza_id: int | str,
    qanoongo_id: int | str,
    mouza_name: str,
    land_classification_id: int | str,
    force: bool = False,
) -> list[dict[str, Any]]:
    body = _rural_lookup_body(
        mouza_id=mouza_id,
        qanoongo_id=qanoongo_id,
        land_classification_id=land_classification_id,
        location="",
        mouza_name=mouza_name,
    )
    data = await _request(
        "AllLocationsByMouzaId",
        params={
            "MouzaName": mouza_name,
            "QanoonGoId": qanoongo_id,
            "landClassificationId": land_classification_id,
        },
        body=body,
        ttl=_TTL_REFERENCE,
        force=force,
    )
    return _norm_items(data)


# ---- Parcel identifiers ---------------------------------------------------

async def rural_khasras(
    *,
    mouza_id: int | str,
    qanoongo_id: int | str,
    mouza_name: str,
    land_classification_id: int | str | None,
    location: str,
    force: bool = False,
) -> list[dict[str, Any]]:
    body = _rural_lookup_body(
        mouza_id=mouza_id,
        qanoongo_id=qanoongo_id,
        land_classification_id=land_classification_id,
        location=location,
        mouza_name=mouza_name,
    )
    data = await _request(
        "KhasrasByLandInfo", body=body, ttl=_TTL_REFERENCE, force=force
    )
    out = []
    for entry in data if isinstance(data, list) else []:
        if not isinstance(entry, dict):
            continue
        number = str(entry.get("KhasraNo") or "").strip()
        if not number:
            continue
        out.append(
            {
                "id": entry.get("KhasraId"),
                "name": number,
                # Rural agricultural Khasras are frequently quoted per Acre.
                "rate_unit": entry.get("KhasraRateUnit"),
            }
        )
    return out


async def rural_square_nos(
    *,
    mouza_id: int | str,
    qanoongo_id: int | str,
    mouza_name: str,
    land_classification_id: int | str | None,
    location: str,
) -> list[dict[str, Any]]:
    body = _rural_lookup_body(
        mouza_id=mouza_id,
        qanoongo_id=qanoongo_id,
        land_classification_id=land_classification_id,
        location=location,
        mouza_name=mouza_name,
    )
    data = await _request(
        "SquareNumbersForDCValuation", body=body, ttl=_TTL_REFERENCE
    )
    out = []
    for entry in data if isinstance(data, list) else []:
        if not isinstance(entry, dict):
            continue
        number = str(entry.get("SquareNo") or "").strip()
        if not number:
            continue
        out.append({"id": entry.get("SquareNoId"), "name": number})
    return out


async def rural_qila_nos(
    *,
    mouza_id: int | str,
    qanoongo_id: int | str,
    mouza_name: str,
    land_classification_id: int | str | None,
    location: str,
    square_no: str,
) -> list[dict[str, Any]]:
    body = _rural_lookup_body(
        mouza_id=mouza_id,
        qanoongo_id=qanoongo_id,
        land_classification_id=land_classification_id,
        location=location,
        mouza_name=mouza_name,
    )
    body["SquareNo"] = square_no
    data = await _request("QilaNumbersForDCValuation", body=body, ttl=_TTL_REFERENCE)
    out = []
    for entry in data if isinstance(data, list) else []:
        if not isinstance(entry, dict):
            continue
        number = str(entry.get("QilaNo") or "").strip()
        if not number:
            continue
        out.append({"id": entry.get("QilaNoId"), "name": number})
    return out


async def urban_availability(
    *, tehsil_id: int | str, town: str, revenue_circle_id: int | str, property_area_id: int | str
) -> dict[str, bool]:
    """Which parcel identifier (if any) this urban Property Area is rated by.

    The portal answers with a single record whose flags select the rate path.
    """
    record = await _urban_probe(
        tehsil_id=tehsil_id,
        town=town,
        revenue_circle_id=revenue_circle_id,
        property_area_id=property_area_id,
    )
    return {
        "khasra": bool(record.get("IsKhasraAvailable")),
        "square_no": bool(record.get("IsSquareNoAvailable")),
    }


async def _urban_probe(
    *, tehsil_id: int | str, town: str, revenue_circle_id: int | str, property_area_id: int | str
) -> dict[str, Any]:
    data = await _request(
        "KhasraUrbanByPropertyArea",
        params={
            "TehsilID": tehsil_id,
            "town": town,
            "RevenueCircleId": revenue_circle_id,
            "PropertyAreaID": property_area_id,
        },
        ttl=_TTL_REFERENCE,
    )
    if isinstance(data, list) and data and isinstance(data[0], dict):
        return data[0]
    return {}


async def urban_land_classifications(
    *,
    tehsil_id: int | str,
    town: str,
    revenue_circle_id: int | str,
    property_area_id: int | str,
    property_area_name: str,
    khasra_no: str = "",
    square_no_id: int | str | None = None,
    qila_no: str = "",
) -> list[dict[str, Any]]:
    """Land classifications available for an urban Property Area.

    The portal narrows this list further once a Khasra or Qila is known, so
    pass those through when you have them.
    """
    base = {
        "tehsilId": tehsil_id,
        "town": town,
        "revenueCircleId": revenue_circle_id,
    }

    if khasra_no:
        params = {
            **base,
            "khasraUrbanNo": khasra_no,
            "PropertyAreaID": property_area_id,
        }
        data = await _request(
            "AllLandClassificationsByPropertyAreaKhasraUrban",
            params=params,
            ttl=_TTL_REFERENCE,
        )
    elif square_no_id and qila_no:
        params = {
            **base,
            "PropertyAreaID": property_area_id,
            "squareNoId": square_no_id,
            "qilaUrbanNo": qila_no,
        }
        data = await _request(
            "AllLandClassificationsByQilaNoUrban", params=params, ttl=_TTL_REFERENCE
        )
    else:
        params = {
            **base,
            "PropertyAreaName": property_area_name,
        }
        data = await _request(
            "AllLandClassificationsByPropertyArea", params=params, ttl=_TTL_REFERENCE
        )
    return _norm_items(data)


async def urban_locations(
    *,
    tehsil_id: int | str,
    town: str,
    revenue_circle_id: int | str,
    property_area_id: int | str,
    land_classification_id: int | str,
    khasra_no: str = "",
    square_no: str = "",
    qila_no: str = "",
) -> list[dict[str, Any]]:
    base = {
        "tehsilId": tehsil_id,
        "town": town,
        "revenueCircleId": revenue_circle_id,
        "PropertyAreaID": property_area_id,
        "landClassificationId": land_classification_id,
    }

    if khasra_no:
        data = await _request(
            "AllLocationsByPropertyAreaIdHavingKhasraNo",
            params={**base, "KhasraNo": khasra_no},
            ttl=_TTL_REFERENCE,
        )
    elif square_no and qila_no:
        data = await _request(
            "AllLocationsByPropertyAreaIdHavingSquareNo",
            params={**base, "squareNo": square_no, "qilaNo": qila_no},
            ttl=_TTL_REFERENCE,
        )
    else:
        data = await _request(
            "AllLocationsByPropertyAreaId", params=base, ttl=_TTL_REFERENCE
        )
    return _norm_items(data)


async def urban_khasras(
    *, tehsil_id: int | str, town: str, revenue_circle_id: int | str, property_area_id: int | str
) -> list[dict[str, Any]]:
    record = await _urban_probe(
        tehsil_id=tehsil_id,
        town=town,
        revenue_circle_id=revenue_circle_id,
        property_area_id=property_area_id,
    )
    # The probe returns a single record naming the Khasra, not a list.
    name = str(record.get("Name") or "").strip()
    if not name or name.lower() == _NO_DATA:
        return []
    return [{"id": record.get("Id"), "name": name}]



async def urban_square_nos(
    *, tehsil_id: int | str, town: str, revenue_circle_id: int | str, property_area_id: int | str
) -> list[dict[str, Any]]:
    data = await _request(
        "SquareNoUrbanByPropertyArea",
        params={
            "TehsilID": tehsil_id,
            "town": town,
            "RevenueCircleId": revenue_circle_id,
            "PropertyAreaID": property_area_id,
        },
        ttl=_TTL_REFERENCE,
    )
    return _norm_items(data)


async def urban_qila_nos(
    *,
    tehsil_id: int | str,
    town: str,
    revenue_circle_id: int | str,
    property_area_id: int | str,
    square_no_id: int | str,
) -> list[dict[str, Any]]:
    data = await _request(
        "QilaNoUrbanBySquareNoId",
        params={
            "TehsilID": tehsil_id,
            "town": town,
            "RevenueCircleId": revenue_circle_id,
            "PropertyAreaID": property_area_id,
            "squareNoID": square_no_id,
        },
        ttl=_TTL_REFERENCE,
    )
    return _norm_items(data)


# --------------------------------------------------------------------------
# Rate lookups
# --------------------------------------------------------------------------

def _extract_rate(payload: Any) -> dict[str, Any]:
    """Pull a human-usable rate out of a portal rate response.

    The portal returns several DC fields encrypted for use inside a signed
    challan (DcRatePerMarla, DCLandRate, DcFtSqRateStringEncrypt). Those are
    deliberately ignored: they are meaningless outside a challan flow, so we
    use the plain rate + unit + per-sqft fields and let the caller multiply
    out the value, exactly as the official page does client-side.
    """
    if not isinstance(payload, dict):
        return {"found": False, "rate": None, "unit": None, "per_sqft": None}

    rate_string = None
    for field in ("KhasraRateString", "QilaNoRateString", "DCRateString"):
        value = payload.get(field)
        if value not in (None, ""):
            rate_string = str(value).strip()
            break

    unit = None
    for field in ("KhasraRateUnit", "QilaNoRateUnit", "DCRateUnit"):
        value = payload.get(field)
        if value not in (None, ""):
            unit = str(value).strip()
            break

    numeric = _to_float(rate_string)
    if numeric is None:
        numeric = _to_float(payload.get("KhasraRate")) or _to_float(payload.get("DCRate"))

    per_sqft = _to_float(payload.get("SqFtRateString")) or _to_float(payload.get("SqFtRate"))

    return {
        "found": numeric is not None and numeric > 0,
        "rate": numeric,
        "rate_string": rate_string,
        "unit": unit,
        "per_sqft": per_sqft,
    }


async def rate_rural_khasra(payload: dict[str, Any]) -> dict[str, Any]:
    body = _rural_lookup_body(
        mouza_id=payload["mouza_id"],
        qanoongo_id=payload["qanoongo_id"],
        land_classification_id=payload.get("land_classification_id"),
        location=payload.get("location", ""),
        mouza_name=payload.get("mouza_name", ""),
    )
    body["KhasraNo"] = str(payload.get("khasra_no") or "").strip()
    data = await _request("MouzaRateByLandInfo", body=body, ttl=_TTL_RATE)
    return _extract_rate(data)


async def rate_rural_qila(payload: dict[str, Any]) -> dict[str, Any]:
    body = _rural_lookup_body(
        mouza_id=payload["mouza_id"],
        qanoongo_id=payload["qanoongo_id"],
        land_classification_id=payload.get("land_classification_id"),
        location=payload.get("location", ""),
        mouza_name=payload.get("mouza_name", ""),
    )
    body["SquareNo"] = str(payload.get("square_no") or "").strip()
    body["QilaNo"] = str(payload.get("qila_no") or "").strip()
    data = await _request(
        "MouzaRateByLandInfoForQilaNo", body=body, ttl=_TTL_RATE
    )
    return _extract_rate(data)


def _urban_rate_body(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "Tehsilid": payload["tehsil_id"],
        "Town": payload.get("town", ""),
        "Floorid": payload.get("floor_id") or 0,
        "PropertyAreaId": payload["property_area_id"],
        "RevenueCircleId": payload["revenue_circle_id"],
        "LandClassificationId": payload.get("land_classification_id") or 0,
        "Location": payload.get("location", ""),
        "PropertyAreaName": payload.get("property_area_name", ""),
        "MarlaQuantity": str(payload.get("area") or 1),
    }


async def rate_urban_area(payload: dict[str, Any]) -> dict[str, Any]:
    body = _urban_rate_body(payload)
    data = await _request(
        "PropertyAreaRateByLandInfo", body=body, ttl=_TTL_RATE
    )
    return _extract_rate(data)


async def rate_urban_khasra(payload: dict[str, Any]) -> dict[str, Any]:
    body = _urban_rate_body(payload)
    body["KhasraUrbanNo"] = str(payload.get("khasra_no") or "").strip()
    data = await _request(
        "PropertyAreaRateByKhasraUrban", body=body, ttl=_TTL_RATE
    )
    return _extract_rate(data)


async def rate_urban_qila(payload: dict[str, Any]) -> dict[str, Any]:
    body = _urban_rate_body(payload)
    body["SquareNoUrban"] = str(payload.get("square_no") or "").strip()
    body["QilaNoUrban"] = str(payload.get("qila_no") or "").strip()
    data = await _request(
        "PropertyAreaRateByQilaNoUrban", body=body, ttl=_TTL_RATE
    )
    return _extract_rate(data)


# --------------------------------------------------------------------------
# Punjab land-area units
# --------------------------------------------------------------------------
# Constants mirror the official portal's own AreaCalculator.js, including
# its selectable interpretations. "Acre" and "Marla" are not single
# definitions in Punjab practice, so both variants are offered rather than
# silently assuming one.

ACRE_TO_KANAL: dict[str, float] = {
    "8": 8.0,       # 1 Acre = 8 Kanal
    "9.65": 9.65,   # 1 Acre = 9 Kanal 13 Marla
    "9.8": 9.8,     # 1 Acre = 9 Kanal 16 Marla
}
KANAL_TO_MARLA: float = 20.0
MARLA_TO_SQFT: dict[str, float] = {
    "272": 272.0,   # revenue/Pucca marla
    "225": 225.0,   # modern marla
}

AREA_UNITS = ("Acre", "Kanal", "Marla", "SqFt")

# Spellings the portal uses for each unit, mapped to our canonical names.
_UNIT_ALIASES = {
    "acre": "Acre",
    "acres": "Acre",
    "kanal": "Kanal",
    "kanals": "Kanal",
    "marla": "Marla",
    "marlas": "Marla",
    "marla ": "Marla",
    "sqft": "SqFt",
    "sq ft": "SqFt",
    "sq. ft": "SqFt",
    "sq. feet": "SqFt",
    "square feet": "SqFt",
    "square foot": "SqFt",
}


def canonical_unit(unit: str | None) -> str | None:
    """Map a portal unit label onto one of AREA_UNITS, if we recognise it."""
    if not unit:
        return None
    key = str(unit).strip().lower()
    if key in _UNIT_ALIASES:
        return _UNIT_ALIASES[key]
    for alias, canonical in _UNIT_ALIASES.items():
        if alias in key:
            return canonical
    return None


def to_marla(
    value: float, unit: str, *, acre_to_kanal: str = "8", marla_to_sqft: str = "272"
) -> float:
    """Convert an area into Marla, the common intermediate unit."""
    if unit == "Acre":
        return value * ACRE_TO_KANAL[acre_to_kanal] * KANAL_TO_MARLA
    if unit == "Kanal":
        return value * KANAL_TO_MARLA
    if unit == "Marla":
        return value
    if unit == "SqFt":
        return value / MARLA_TO_SQFT[marla_to_sqft]
    raise ValueError(f"Unknown area unit: {unit!r}")


def convert_area(
    value: float,
    from_unit: str,
    to_unit: str,
    *,
    acre_to_kanal: str = "8",
    marla_to_sqft: str = "272",
) -> float:
    """Convert between Acre / Kanal / Marla / SqFt."""
    marla = to_marla(
        value, from_unit, acre_to_kanal=acre_to_kanal, marla_to_sqft=marla_to_sqft
    )
    if to_unit == "Acre":
        return marla / (ACRE_TO_KANAL[acre_to_kanal] * KANAL_TO_MARLA)
    if to_unit == "Kanal":
        return marla / KANAL_TO_MARLA
    if to_unit == "Marla":
        return marla
    if to_unit == "SqFt":
        return marla * MARLA_TO_SQFT[marla_to_sqft]
    raise ValueError(f"Unknown area unit: {to_unit!r}")


def round_area(value: float) -> float:
    """Match the official calculator's 4-decimal rounding."""
    return round(value + 0.0, 4)


def land_value(
    *,
    area: float,
    area_unit: str,
    rate: float,
    rate_unit: str,
    acre_to_kanal: str = "8",
    marla_to_sqft: str = "272",
) -> dict[str, Any]:
    """Value the land at the DC rate.

    The rate is quoted per `rate_unit`, which is not always Marla (rural
    agricultural Khasras commonly come back per Acre), so the entered area
    is converted into the rate's own unit before multiplying. This mirrors
    the official page, which simply shows rate x entered-area and asks for
    the area in the rate's unit.
    """
    area_in_rate_unit = convert_area(
        area,
        area_unit,
        rate_unit,
        acre_to_kanal=acre_to_kanal,
        marla_to_sqft=marla_to_sqft,
    )
    total = area_in_rate_unit * rate

    # Per-sqft implied by the total: divide the whole area's value by the
    # whole area in sq ft. Dividing by one *unit* of area instead would
    # inflate the result by the area figure.
    total_sqft = convert_area(
        area, area_unit, "SqFt", acre_to_kanal=acre_to_kanal, marla_to_sqft=marla_to_sqft
    )
    return {
        "total": total,
        "area_in_rate_unit": area_in_rate_unit,
        "total_sqft": total_sqft,
        "implied_per_sqft": (total / total_sqft) if total_sqft else None,
    }
