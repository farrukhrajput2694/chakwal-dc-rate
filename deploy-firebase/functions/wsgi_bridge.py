"""
Run the FastAPI app as a plain WSGI callable.

Cloud Functions for Firebase serves Python through the Functions Framework,
which speaks WSGI. FastAPI speaks ASGI. This module is the whole of that gap:
`a2wsgi.ASGIMiddleware` turns the ASGI app into a WSGI callable, and `call()`
drives that callable and collects the result.

Note the direction. In a2wsgi the class is named after the type it *takes*, so
`WSGIMiddleware(wsgi_app)` produces something callable as ASGI -- the opposite
of what is needed here. `ASGIMiddleware(fastapi_app)` is the one that produces
something callable as WSGI. Getting these two backwards is easy and produces a
function that imports cleanly and then fails on the first request.

Starlette's own `starlette.middleware.wsgi.WSGIMiddleware` does the same job and
was the obvious choice, but it is deprecated as of Starlette 1.7 ("please refer
to a2wsgi"), so this uses a2wsgi rather than pinning a version that will warn on
every cold start.

This lives in its own module, away from the Firebase entrypoint, because it is
the only part of a Functions deployment that can be exercised without a Firebase
account. `python wsgi_bridge.py` runs a self-test that drives the real app
through this bridge and prints the answers, so the risky half of the deployment
can be checked on an ordinary machine.
"""

from __future__ import annotations

import io
from typing import Any, Callable, Iterable, Mapping

# Hop-by-hop headers, per RFC 9110 7.6.1. They describe the connection between
# this process and whatever called it, not the response itself, and the platform
# sets its own. Forwarding them can produce a response that disagrees with the
# connection it is being sent on.
_HOP_BY_HOP = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)


def call(
    wsgi_app: Callable[[dict, Callable], Iterable[bytes]],
    environ: dict,
) -> tuple[int, list[tuple[str, str]], bytes]:
    """Run one WSGI request and return ``(status, headers, body)``.

    `wsgi_app` is a plain WSGI callable, i.e. ``app(environ, start_response)``.
    `environ` is the request; on a Firebase function it is simply the environ
    the Functions Framework already built, so nothing has to be re-derived from
    the request object.
    """
    captured: dict[str, Any] = {}

    def start_response(
        status: str,
        headers: list[tuple[str, str]],
        exc_info: Any = None,
    ) -> Callable[[bytes], None]:
        # PEP 3333: when a handler has already sent headers and then fails, it
        # calls start_response a second time with exc_info set, and the correct
        # behaviour is to re-raise rather than replace the response. Honouring
        # that here means an error inside the ASGI app propagates as itself
        # instead of surfacing as a truncated body under a 200.
        if exc_info is not None:
            raise exc_info[1].with_traceback(exc_info[2])
        captured["status"] = status
        captured["headers"] = [
            (str(k), str(v)) for k, v in headers
            if str(k).lower() not in _HOP_BY_HOP
        ]
        return _discard

    result = wsgi_app(environ, start_response)
    try:
        chunks: list[bytes] = []
        for chunk in result:
            chunks.append(chunk.encode("utf-8") if isinstance(chunk, str) else chunk)
        body = b"".join(chunks)
    finally:
        # PEP 3333 requires the server to call close() if the iterable has one.
        close = getattr(result, "close", None)
        if close is not None:
            close()

    if "status" not in captured:
        # Only reachable if the app returned without ever calling
        # start_response, which is a protocol violation on its side.
        raise RuntimeError("WSGI app returned without calling start_response")

    code = int(str(captured["status"]).split(None, 1)[0])
    return code, captured["headers"], body


def _discard(_data: bytes) -> None:
    """The `write` callable WSGI hands to start_response.

    Not used: the response is assembled from the returned iterable, which is
    what a2wsgi produces. It has to exist and be callable regardless.
    """


def make_environ(
    method: str,
    path: str,
    *,
    query_string: str = "",
    body: bytes = b"",
    content_type: str = "application/json",
    host: str = "localhost",
    port: str = "443",
    scheme: str = "https",
) -> dict:
    """Build a minimal but valid WSGI environ.

    Only used by the self-test below, and by anyone who wants to exercise the
    bridge on a machine with no Firebase project. A real function does not call
    this: it receives the environ the platform already built.
    """
    environ: dict[str, Any] = {
        "REQUEST_METHOD": method.upper(),
        "PATH_INFO": path,
        "QUERY_STRING": query_string,
        "SERVER_NAME": host,
        "SERVER_PORT": port,
        "SERVER_PROTOCOL": "HTTP/1.1",
        "SCRIPT_NAME": "",
        "CONTENT_TYPE": content_type,
        "CONTENT_LENGTH": str(len(body)),
        "wsgi.version": (1, 0),
        "wsgi.url_scheme": scheme,
        "wsgi.input": io.BytesIO(body),
        "wsgi.errors": io.StringIO(),
        "wsgi.multithread": True,
        "wsgi.multiprocess": False,
        "wsgi.run_once": False,
        "HTTP_HOST": host,
        "HTTP_ACCEPT": "*/*",
    }
    return environ


# --------------------------------------------------------------------------
# Self-test.  `python wsgi_bridge.py`
# --------------------------------------------------------------------------
#
# Drives the real FastAPI app through the real bridge, with no Firebase, no
# network listener and no account. The endpoints chosen cover the three shapes
# the app answers with -- a plain JSON object, a JSON list, and a validated POST
# -- because a bridge that mangles one of them will still look fine on the
# others.


def _selftest() -> int:
    import json
    import os
    import sys

    os.environ.setdefault("RATE_APP_SERVERLESS", "1")
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

    from a2wsgi import ASGIMiddleware

    from app import app as fastapi_app

    wsgi = ASGIMiddleware(fastapi_app)

    # (label, method, path, query, body, expected status, expect-json-list)
    checks: list[tuple[str, str, str, str, str, int, bool]] = [
        ("health", "GET", "/health", "", "", 200, False),
        ("units", "GET", "/api/units", "", "", 200, False),
        ("scope", "GET", "/api/scope", "", "", 200, False),
        ("links", "GET", "/api/links", "", "", 200, False),
        # The first check that touches the portal. If a bridge can pass the
        # four above but mangle a streamed or large body, this is where it
        # shows, so it is here rather than at the end.
        ("qanoongoes (live portal call)", "GET", "/api/qanoongoes", "tehsilId=75", "", 200, True),
        (
            "convert Kanal -> Acre",
            "POST",
            "/api/convert",
            "",
            '{"value": 3.5, "from_unit": "Kanal", "to_unit": "Acre"}',
            200,
            False,
        ),
        # Validation must survive the bridge as a 422 with FastAPI's own body.
        # A 500 here would mean the body was not readable to the ASGI app.
        (
            "convert with a bad unit -> 422",
            "POST",
            "/api/convert",
            "",
            '{"value": 3.5, "from_unit": "Banana", "to_unit": "Acre"}',
            422,
            False,
        ),
        # Serverless mode must stay on: this is 501 by design, because it
        # assumes a process that stays alive. If it returns 200 the
        # RATE_APP_SERVERLESS env var did not reach app.py. The queued-batch
        # 501 is not checked here because that handler takes a required body,
        # so an empty POST is rejected by validation with a 422 before the
        # guard is ever reached -- it would test nothing.
        ("nightly refresh is off -> 501", "POST", "/api/refresh", "", "", 501, False),
    ]

    failures = 0
    for label, method, path, query, payload, expected_status, want_list in checks:
        body = payload.encode("utf-8")
        environ = make_environ(method, path, query_string=query, body=body)
        status, headers, raw = call(wsgi, environ)

        ok = status == expected_status
        detail = ""
        if ok and want_list:
            try:
                ok = isinstance(json.loads(raw), list)
            except ValueError:
                ok = False
            detail = " (expected a JSON list)"
        label = f"{method} {path} -- {label}"
        if ok:
            head = raw[:90].decode("utf-8", "replace").replace("\n", " ")
            print(f"  ok    {status}  {label}{detail}")
            print(f"        {head}")
        else:
            failures += 1
            print(f"  FAIL  {status} (wanted {expected_status})  {label}{detail}")
            print(f"        {raw[:200].decode('utf-8', 'replace')}")

        for name in ("content-type", "cache-control"):
            found = [v for k, v in headers if k.lower() == name]
            if found:
                print(f"        {name}: {found[0]}")

    print()
    if failures:
        print(f"  {failures} check(s) failed")
        return 1
    print("  bridge self-test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(_selftest())
