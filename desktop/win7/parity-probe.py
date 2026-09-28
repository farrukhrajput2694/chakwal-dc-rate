"""Runs the shared validation cases against ONE build and prints JSON.

    python parity-probe.py --mode win7
    python parity-probe.py --mode fastapi

This exists because the two builds cannot be loaded into one interpreter, and
that is the whole point of the split. The Windows 7 build's environment has no
FastAPI by design -- FastAPI is one of the packages Windows 7 cannot run -- and
the FastAPI build runs on Python 3.12 with a full dependency set. So each side
is exercised by the interpreter that can actually run it, and the results are
printed as JSON for desktop/win7/test-server.py to compare.

It prints one JSON document on stdout and nothing else, so a caller can parse
it without having to strip human-readable noise.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

# The known-good parcel. Shared with test-server.py so both probes send byte-
# identical requests and a difference can only be an implementation difference.
KNOWN = {
    "land_type": "rural",
    "path": "khasra",
    "district_id": 21,
    "tehsil_id": 75,
    "mouza_id": 11376,
    "mouza_name": "Alawal",
    "qanoongo_id": 507,
    "land_classification_id": 1,
    "land_classification_name": "Agricultural",
    "location": "Link Road",
    "khasra_no": "947",
    "area": 3.5,
    "area_unit": "Kanal",
}

# (name, payload, endpoint, expected_to_be_refused)
# Chosen to cover every rule the two builds share, and deliberately to avoid the
# portal entirely except for the last one, so the comparison does not depend on
# the portal being up.
CASES = [
    ("another tehsil", dict(KNOWN, tehsil_id=74), "api/rate", True),
    ("another district", dict(KNOWN, district_id=20), "api/rate", True),
    ("wrong tehsil name", dict(KNOWN, tehsil_name="Sahiwal"), "api/rate", True),
    ("wrong district name", dict(KNOWN, district_name="Lahore"), "api/rate", True),
    ("no district at all", {k: v for k, v in KNOWN.items()
                            if k not in ("district_id", "district_name")},
     "api/rate", False),
    ("missing Khasra number", dict(KNOWN, khasra_no=""), "api/rate", True),
    ("missing Mouza", dict(KNOWN, mouza_id=None), "api/rate", True),
    ("missing Qanoongoee", dict(KNOWN, qanoongo_id=None), "api/rate", True),
    ("blank Qanoongoee", dict(KNOWN, qanoongo_id=""), "api/rate", True),
    ("qila path without Square", dict(KNOWN, path="qila", square_no="",
                                      qila_no="9"), "api/rate", True),
    ("area path on rural land", dict(KNOWN, path="area"), "api/rate", True),
    ("zero area", dict(KNOWN, area=0), "api/rate", True),
    ("negative area", dict(KNOWN, area=-5), "api/rate", True),
    ("non-numeric area", dict(KNOWN, area="lots"), "api/rate", True),
    ("unknown area unit", dict(KNOWN, area_unit="Biscuit"), "api/rate", True),
    ("bad acre_to_kanal", dict(KNOWN, acre_to_kanal="7"), "api/rate", True),
    ("bad marla_to_sqft", dict(KNOWN, marla_to_sqft="100"), "api/rate", True),
    ("unknown land_type", dict(KNOWN, land_type="martial"), "api/rate", True),
    ("unknown path", dict(KNOWN, path="bungalow"), "api/rate", True),
    ("non-numeric mouza_id", dict(KNOWN, mouza_id="abc"), "api/rate", True),
    ("defaults accepted", {k: v for k, v in KNOWN.items()
                           if k not in ("area", "area_unit")}, "api/rate", False),
    ("9.65 kanal variant", dict(KNOWN, acre_to_kanal="9.65"), "api/rate", False),
    ("225 sqft variant", dict(KNOWN, marla_to_sqft="225"), "api/rate", False),
    ("urban with no Revenue Circle",
     dict(KNOWN, land_type="urban", town="Chakwal", property_area_id=1,
          revenue_circle_id=None, path="khasra"), "api/rate", True),
    ("batch with no Khasras", dict(KNOWN, khasras=[]), "api/rates/batch", True),
    ("batch of a non-list", dict(KNOWN, khasras="947"), "api/rates/batch", True),
    ("batch on urban land", dict(KNOWN, land_type="urban", khasras=["947"]),
     "api/rates/batch", True),
    ("batch with a qila path", dict(KNOWN, path="qila", khasras=["947"]),
     "api/rates/batch", True),
    ("body is a list not an object", [1, 2, 3], "api/rate", True),
]


def _summarise(status: int, body) -> dict:
    """Reduce a response to what two implementations must agree about.

    Status codes are normalised: FastAPI answers a constraint violation with
    422 and a list of pydantic error objects, while the Win7 server has no
    pydantic and answers 400 with a sentence. That difference is correct and
    deliberate -- the front end renders `data.detail`, and a list of objects
    would appear to the user as "[object Object]" -- so what has to match is the
    decision (refuse / accept) and whether the refusal explained itself, not
    the code.
    """
    refused = status in (400, 422)
    detail = None
    if isinstance(body, dict):
        detail = body.get("detail")
        if isinstance(detail, list):
            # pydantic's shape: [ {loc, msg, type}, ... ]
            msgs = [str(d.get("msg", "")) for d in detail if isinstance(d, dict)]
            detail = "; ".join(m for m in msgs if m) or None
        elif detail is not None:
            detail = str(detail)
    return {
        "status": status,
        "refused": refused,
        "explained": bool(detail),
        "detail": (detail or "")[:200],
    }


def run_win7(cases) -> list:
    import server

    web_root = os.path.join(ROOT, "desktop", "web")
    httpd, _thread, portal, base = server.serve(web_root)
    import urllib.error
    import urllib.request

    out = []
    try:
        for name, payload, endpoint, _refused in cases:
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                base + endpoint, data=data,
                headers={"Content-Type": "application/json"},
            )
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    status, raw = resp.status, resp.read().decode("utf-8", "replace")
            except urllib.error.HTTPError as exc:
                status, raw = exc.code, exc.read().decode("utf-8", "replace")
            try:
                body = json.loads(raw)
            except ValueError:
                body = raw
            row = _summarise(status, body)
            row["name"] = name
            row["expect_refused"] = _refused
            out.append(row)
    finally:
        httpd.shutdown()
        portal.stop()
    return out


def run_fastapi(cases) -> list:
    from fastapi.testclient import TestClient

    import app as fastapi_app

    client = TestClient(fastapi_app.app)
    out = []
    for name, payload, endpoint, _refused in cases:
        resp = client.post("/" + endpoint, json=payload)
        try:
            body = resp.json()
        except ValueError:
            body = resp.text
        row = _summarise(resp.status_code, body)
        row["name"] = name
        row["expect_refused"] = _refused
        out.append(row)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", required=True, choices=["win7", "fastapi"])
    args = parser.parse_args()

    if args.mode == "win7":
        rows = run_win7(CASES)
    else:
        rows = run_fastapi(CASES)
    sys.stdout.write(json.dumps(rows))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
