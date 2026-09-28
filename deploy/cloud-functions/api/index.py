# EdgeOne Pages Cloud Function -- FastAPI (ASGI) mode, mounted at /api.
#
# Why this file sits at cloud-functions/api/index.py, and why there is a wrapper
# ---------------------------------------------------------------------
# Three platform behaviours were verified against the EdgeOne CLI's own source
# after three deploys succeeded at the CLI level and served a broken site.
#
# 1. Entry recognition. The builder registers a .py file as a function only if
#    it matches /^app\s*(?::\s*\S+\s*)?=\s*/m -- a line starting with `app =`.
#    A file that merely does `from app import app` is skipped silently, and the
#    builder then registers some other file instead. The `app = ...` line at the
#    bottom of this file is what makes this the entry. Do not remove it or fold
#    it into an import-only re-export.
#
# 2. Filename "index" is what makes the route a prefix rather than a leaf. A
#    file named app.py would register at /app; index.py inside api/ registers at
#    /api, and the platform expands that to ^/api(?:/.*)?$.
#
# 3. The runtime strips the route prefix before calling the framework:
#
#       if self.static_prefix != '/' and request_path.startswith(...):
#           scope['path'] = request_path[len(self.static_prefix):]
#
#    so /api/rates arrives here as /rates, while app.py declares /api/rates.
#    _RestorePrefix puts the prefix back before the real app ever routes, which
#    keeps app.py byte-identical to the local copy -- no route strings had to be
#    edited in two places.
#
# Note the alternative was tried first and does not work: mounting at the root
# (cloud-functions/index.py) generates the source pattern ^/(?:/.*)?$, which
# matches only "/" and paths beginning with "//" -- never /api/rates. That is a
# CLI bug for root-mounted framework functions, not a config mistake.
#
# app.py and govapi.py live one directory up, so they are unambiguous helper
# modules; the builder copies non-entry .py files into the bundle.
#
# Serverless mode is on. Three parts of this app assume a process that stays
# alive, and all three are actively harmful where that is not true:
#
#   * The nightly reference-list refresh. Its boot-time staleness check would
#     find an empty cache on every cold start and decide to re-walk all 1,070
#     lists -- about 2,300 calls to a government server -- per request. Off.
#   * Queued bulk runs. A job lives in this process's memory, so the client's
#     status poll would hit a different instance and 404. Off; batches are
#     synchronous, bounded by the platform's 120s request limit.
#   * The SQLite history file. Nothing writes to it any more, and a read-only
#     filesystem should not be able to fail a request.
#
# What is unaffected, and is most of the app: every portal read, the rate and
# area maths, the tehsil scope guard, and the entire frontend.

import os
import sys

# app.py / govapi.py are one level up from this file.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("RATE_APP_SERVERLESS", "1")

from app import app as _app  # noqa: E402  (sys.path must be set up first)

PREFIX = "/api"


class _RestorePrefix:
    """Re-attach the stripped route prefix before handing over to the real app.

    A bare ASGI callable, deliberately not a FastAPI subclass, so that adding
    the prefix cannot be defeated by anything the real app does with its own
    root_path handling.
    """

    def __init__(self, inner, prefix):
        self.inner = inner
        self.prefix = prefix

    async def __call__(self, scope, receive, send):
        if scope.get("type") in ("http", "websocket"):
            scope = dict(scope)
            path = scope.get("path", "/")
            if not path.startswith(self.prefix):
                if not path.startswith("/"):
                    path = "/" + path
                scope["path"] = self.prefix + path
            # The runtime set root_path to the prefix for its own bookkeeping.
            # Starlette would otherwise prepend it to generated URLs, so clear it.
            scope["root_path"] = ""
        await self.inner(scope, receive, send)


# Required by the builder's entry-point pattern -- see note 1 above.
app = _RestorePrefix(_app, PREFIX)

__all__ = ["app"]
