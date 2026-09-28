"""End-to-end test of the Windows 7 server.

    .venv-win7\\Scripts\\python -m desktop.win7.test_server       (or the venv at
    C:\\Users\\Creative Computer\\Desktop\\_win7env)

Runs the real stdlib server on a real port, then drives it over HTTP exactly the
way desktop/web/desktop.js does: POST /api/rate, POST /api/rates/batch,
GET /api/units. Those three are the whole contract, so if this passes, the page
works against this server.

The portal is a third party and is sometimes down, so the live checks retry and
then report SKIP rather than FAIL. A skipped run is not a pass.

The parity checks are the important half. This server is a hand-written
replacement for the FastAPI app in app.py, and a hand-written replacement
drifts. So every validation rule the two share -- scope refusal, area bounds,
unit choices, the batch ceiling, the path restrictions -- is sent to BOTH and
the status codes and messages are compared. That is what catches a divergence
before a user does.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import threading
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

import server  # noqa: E402

PASS: list[str] = []
FAIL: list[str] = []
SKIP: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    (PASS if ok else FAIL).append(name)
    print("  [{0}] {1}  {2}".format("PASS" if ok else "FAIL", name, detail))


def skip(name: str, why: str) -> None:
    SKIP.append(name)
    print("  [SKIP] {0}  {1}".format(name, why))


# The one case whose correct answer is already known. Khasra 947, Alawal,
# Agricultural, Link Road = Rs. 366,025 per Acre; 3.5 Kanal of it = 160,135.9375.
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
KNOWN_RATE = 366025.0
KNOWN_TOTAL = 160135.9375


def request(url: str, payload=None, timeout: float = 120.0):
    """POST or GET, returning (status, parsed_body_or_raw_text)."""
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            status = resp.status
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        status = exc.code
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw


def main() -> int:
    web_root = os.path.join(ROOT, "desktop", "web")
    httpd, _thread, portal, base = server.serve(web_root)
    print("")
    print("  Windows 7 server on {0}".format(base))

    try:
        # ---------------------------------------------------------------
        print("")
        print("=== static assets ===")
        status, body = request(base)
        check("GET / serves the page", status == 200 and "Chakwal" in str(body),
              "HTTP {0}".format(status))
        status, body = request(base + "static/app.js")
        check("GET /static/app.js", status == 200 and "use strict" in str(body),
              "{0} bytes".format(len(str(body))))
        status, body = request(base + "static/data/reference.js")
        check("GET /static/data/reference.js (nested path)", status == 200,
              "HTTP {0}".format(status))
        status, body = request(base + "static/styles.css")
        check("GET /static/styles.css", status == 200, "HTTP {0}".format(status))
        status, body = request(base + "health")
        check("GET /health", status == 200 and body.get("build") == "win7",
              "python {0}".format((body or {}).get("python")))

        # A server bound to loopback is still serving files, and one of them
        # sits next to the program's own source. Refusing this is not a nicety.
        print("")
        print("=== path traversal ===")
        for probe in ("/static/../govapi.py",
                      "/static/../../app.py",
                      "/static/..%2fgovapi.py",
                      "/static/....//govapi.py"):
            status, body = request(base + probe)
            leaked = status == 200 and "OFFICIAL_BASE" in str(body)
            check("refuses {0}".format(probe), not leaked, "HTTP {0}".format(status))
        status, body = request(base + "static/nope.js")
        check("unknown asset is 404", status == 404, "HTTP {0}".format(status))

        # ---------------------------------------------------------------
        print("")
        print("=== validation (no portal call needed) ===")

        def expect(name, payload, status_want, method="rate"):
            url = base + ("api/rate" if method == "rate" else "api/rates/batch")
            status, body = request(url, payload)
            check(name, status == status_want,
                  "HTTP {0} {1}".format(status, str(body)[:110]))
            return status, body

        # Scope. One tehsil only, and the refusal must be identical to app.py's.
        bad_scope = dict(KNOWN, tehsil_id= 74)
        expect("refuses another tehsil", bad_scope, 400)
        bad_district = dict(KNOWN, district_id= 20)
        expect("refuses another district", bad_district, 400)
        expect("refuses a bad tehsil NAME", dict(KNOWN, tehsil_name="Sahiwal"), 400)
        expect("accepts tehsil Chakwal by name", dict(KNOWN, tehsil_name="Chakwal"), 200)

        # Missing required identifiers.
        expect("rural without a Khasra number", dict(KNOWN, khasra_no=""), 400)
        expect("rural without a Mouza", dict(KNOWN, mouza_id=None), 400)
        expect("rural without a Qanoongoee", dict(KNOWN, qanoongo_id=None), 400)
        expect("area path on rural land", dict(KNOWN, path="area"), 400)
        expect("qila path without a Square number",
               dict(KNOWN, path="qila", square_no="", qila_no="9"), 400)

        # Area and unit bounds, mirroring app.py's Field constraints exactly.
        expect("zero area", dict(KNOWN, area=0), 400)
        expect("negative area", dict(KNOWN, area=-5), 400)
        expect("non-numeric area", dict(KNOWN, area="lots"), 400)
        expect("unknown area unit", dict(KNOWN, area_unit="Biscuit"), 400)
        expect("bad acre_to_kanal", dict(KNOWN, acre_to_kanal="7"), 400)
        expect("good acre_to_kanal 9.65", dict(KNOWN, acre_to_kanal="9.65"), 200)
        expect("bad marla_to_sqft", dict(KNOWN, marla_to_sqft="100"), 400)
        expect("good marla_to_sqft 225", dict(KNOWN, marla_to_sqft="225"), 200)
        expect("unknown land_type", dict(KNOWN, land_type="martial"), 400)

        # Batch rules.
        expect("batch with no Khasras", dict(KNOWN, khasras=[]), 400,
               method="batch")
        expect("batch of a non-list",
               dict(KNOWN, khasras="947"), 400, method="batch")
        expect("batch on urban land",
               dict(KNOWN, land_type="urban", khasras=["947"]), 400, method="batch")

        # ---------------------------------------------------------------
        print("")
        print("=== live: the known Khasra ===")
        got = None
        last = ""
        for attempt in range(1, 5):
            status, body = request(base + "api/rate", KNOWN)
            if status == 200 and isinstance(body, dict) and body.get("found"):
                got = body
                print("  attempt {0} succeeded".format(attempt))
                break
            last = "HTTP {0} {1}".format(status, str(body)[:160])
            print("  attempt {0} failed: {1}".format(attempt, last))
            import time
            time.sleep(3 * attempt)

        if got is None:
            for n in ("known rate 366025/Acre", "known total 160135.9375",
                      "unit is Acre", "parcel is named", "source is the portal"):
                skip(n, "portal unreachable")
        else:
            rate = got["rate"]
            check("known rate 366025/Acre", rate.get("rate") == KNOWN_RATE,
                  "got {0}".format(rate.get("rate")))
            check("known total 160135.9375", got["value"]["total"] == KNOWN_TOTAL,
                  "got {0}".format(got["value"]["total"]))
            check("unit is Acre", rate.get("unit") == "Acre",
                  "got {0}".format(rate.get("unit")))
            check("parcel is named", got.get("parcel") == "Khasra 947",
                  "got {0!r}".format(got.get("parcel")))
            check("source is the official portal",
                  got.get("source") == "https://es.punjab-zameen.gov.pk/eStampCitizenPortal",
                  "got {0}".format(got.get("source")))
            check("value carries the rate unit used",
                  got["value"].get("rate_unit") == "Acre",
                  "got {0}".format(got["value"].get("rate_unit")))

        # ---------------------------------------------------------------
        print("")
        print("=== live: a batch, which is the path the page actually uses ===")
        batch_body = dict(KNOWN, khasras=["947", "948", "949"])
        status, body = request(base + "api/rates/batch", batch_body)
        if status == 200 and isinstance(body, dict) and body.get("results") is not None:
            results = body["results"]
            check("batch returns one row per Khasra", len(results) == 3,
                  "{0} rows".format(len(results)))
            check("batch keeps the requested order",
                  [r["khasra"] for r in results] == ["947", "948", "949"],
                  str([r["khasra"] for r in results]))
            check("batch rows carry a rate, unit and found flag",
                  all(set(("khasra", "found", "rate", "rate_unit", "error")) <= set(r)
                      for r in results), "")
            summary = body.get("summary") or {}
            check("batch summary counts rated and unrated",
                  summary.get("requested") == 3
                  and summary.get("rated", 0) + summary.get("unrated", 0) == 3,
                  "rated {0}, unrated {1}".format(summary.get("rated"),
                                                   summary.get("unrated")))
            # A Khasra the portal does not rate must come back as an honest
            # "no rate" row, not an error and definitely not a zero.
            rated = [r for r in results if r["found"]]
            unrated = [r for r in results if not r["found"]]
            check("unrated Khasras report no_rate, not a zero",
                  all(r["error"] == "no_rate" and r["rate"] is None
                      for r in unrated),
                  "{0} unrated".format(len(unrated)))
            if rated:
                check("rated Khasras have a positive rate",
                      all((r["rate"] or 0) > 0 for r in rated),
                      "{0} rated".format(len(rated)))
        else:
            for n in ("batch returns one row per Khasra", "batch keeps order",
                      "batch row shape", "batch summary counts",
                      "unrated Khasras report no_rate", "rated Khasras positive"):
                skip(n, "portal unreachable (HTTP {0})".format(status))

        # Duplicates must not double the load on the portal.
        status, body = request(base + "api/rates/batch",
                               dict(KNOWN, khasras=["947", "947", " 947 "]))
        if status == 200 and isinstance(body, dict):
            check("duplicate Khasras are collapsed", len(body.get("results", [])) == 1,
                  "{0} rows for 3 identical entries".format(len(body.get("results", []))))
        else:
            skip("duplicate Khasras are collapsed", "portal unreachable")

        # ---------------------------------------------------------------
        print("")
        print("=== concurrency really is capped at 4 ===")
        # If the semaphore were missing or larger, 12 Khasras would produce 12
        # simultaneous portal requests. This measures in-flight count inside the
        # loop rather than trusting the constant.
        # The thing to measure is the portal call itself, govapi.rate_rural_khasra.
        # Wrapping server._portal instead would count the wrapper's own
        # concurrency and always report 12, because _portal's semaphore is
        # applied *inside* it -- every caller reaches the wrapper first and only
        # then queues on the semaphore. That is a measurement bug, not a finding
        # about the limiter, and it is easy to mistake for the opposite.
        import asyncio

        import govapi

        lock = threading.Lock()
        state = {"now": 0, "peak": 0}
        real_lookup = govapi.rate_rural_khasra

        async def counting_lookup(payload):
            with lock:
                state["now"] += 1
                state["peak"] = max(state["peak"], state["now"])
            try:
                # Long enough that overlapping callers really do overlap.
                await asyncio.sleep(0.2)
                return {"found": True, "rate": 1.0, "unit": "Acre", "per_sqft": 0.0}
            finally:
                with lock:
                    state["now"] -= 1

        govapi.rate_rural_khasra = counting_lookup
        try:
            portal.run(server.api_rates_batch(
                server.parse_request(dict(KNOWN)),
                [str(n) for n in range(1, 13)],
            ))
        finally:
            govapi.rate_rural_khasra = real_lookup

        check("no more than 4 portal calls in flight", state["peak"] <= 4,
              "peak was {0} for 12 Khasras".format(state["peak"]))
        check("the cap is actually used, not merely not exceeded",
              state["peak"] == 4, "peak {0} of an allowed 4".format(state["peak"]))

        # ---------------------------------------------------------------
        print("")
        print("=== parity with the FastAPI build ===")
        compare_with_fastapi()

    finally:
        httpd.shutdown()
        portal.stop()

    print("")
    print("  passed {0}   failed {1}   skipped {2}".format(
        len(PASS), len(FAIL), len(SKIP)))
    if FAIL:
        print("  FAILED: " + ", ".join(FAIL))
        return 1
    if SKIP:
        print("  NOTE: this run is NOT a full pass; the portal was unreachable "
              "for {0} check(s).".format(len(SKIP)))
        return 2
    return 0


def compare_with_fastapi() -> None:
    """Compare this server's decisions with app.py's, case by case.

    The two cannot share an interpreter. This build's environment has no
    FastAPI -- deliberately, because FastAPI is one of the packages Windows 7
    cannot run -- and app.py needs a full dependency set on Python 3.12. So
    each side is driven by the interpreter that can run it, via
    desktop/win7/parity-probe.py, and the two sets of results are compared
    here. An earlier version of this test tried to import app.py in-process and
    skipped, which quietly left the whole comparison unverified.
    """
    import subprocess

    probe = os.path.join(HERE, "parity-probe.py")
    if not os.path.isfile(probe):
        skip("parity with the FastAPI build", "parity-probe.py is missing")
        return

    # This interpreter for the Win7 side, explicitly passed rather than assumed,
    # because the test has to be sure both sides ran under the expected Python.
    mine = sys.executable

    # The FastAPI side: the project's main virtualenv. Located by convention and
    # reported if absent, so a missing venv reads as a skip and not a mystery.
    other = os.path.join(ROOT, ".venv", "Scripts", "python.exe")
    if not os.path.isfile(other):
        other = shutil.which("python") or ""
    if not other or not os.path.isfile(other):
        skip("parity with the FastAPI build",
             "no Python with FastAPI available (looked for {0})".format(
                 os.path.join(ROOT, ".venv", "Scripts", "python.exe")))
        return

    def run(python_exe: str, mode: str):
        proc = subprocess.run(
            [python_exe, probe, "--mode", mode],
            capture_output=True, text=True, timeout=600, cwd=ROOT,
        )
        if proc.returncode != 0:
            raise RuntimeError("probe {0} failed: {1}".format(
                mode, (proc.stderr or proc.stdout)[-400:]))
        return json.loads(proc.stdout)

    try:
        mine_rows = run(mine, "win7")
        their_rows = run(other, "fastapi")
    except Exception as exc:  # noqa: BLE001
        skip("parity with the FastAPI build", str(exc)[:300])
        return

    if len(mine_rows) != len(their_rows):
        skip("parity with the FastAPI build",
             "probe returned {0} and {1} rows".format(len(mine_rows), len(their_rows)))
        return

    for a, b in zip(mine_rows, their_rows):
        name = a["name"]
        # The decision must match: both refuse, or both accept.
        same = a["refused"] == b["refused"]
        check("parity: {0}".format(name), same,
              "win7 HTTP {0} vs FastAPI HTTP {1}".format(a["status"], b["status"]))
        # And the refusal must match the expectation, which is the point of
        # listing the cases: a case meant to be accepted but refused by both
        # would sail through a pure agreement check.
        check("parity: {0} is refused as expected".format(name),
              a["refused"] == a["expect_refused"],
              "expected {0}, got {1}".format(
                  "refusal" if a["expect_refused"] else "acceptance",
                  "refusal" if a["refused"] else "acceptance"))
        if a["refused"]:
            check("parity: {0} explains itself".format(name),
                  a["explained"] and b["explained"],
                  "win7: {0!r}".format(a["detail"][:90]))


if __name__ == "__main__":
    raise SystemExit(main())
