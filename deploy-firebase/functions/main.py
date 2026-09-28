"""Firebase Cloud Function entrypoint for the Chakwal DC rate calculator.

The app itself (app.py, govapi.py) is unchanged from the local build. This
module is the adapter between it and the platform, and it is deliberately thin:
everything it does is one dict lookup on the request, one call into the WSGI
bridge, and one Response. The bridge is the part that carries real risk, which
is why it lives in wsgi_bridge.py and can be tested without a Firebase account.


Concurrency, and why it is pinned to 1
--------------------------------------

app.py caps portal traffic with a process-wide `_PriorityLimiter` of
BATCH_CONCURRENCY (4). On uvicorn that is a genuine global cap, because one
process serves one request at a time. On Cloud Functions it is not: one instance
process handles `concurrency` simultaneous requests, and each of those gets its
own 4 portal calls. At the default concurrency of 80, a single instance could
have 320 requests in flight to a government server.

So both knobs are set to 1:

  concurrency=1     one request per instance process, so the in-app cap of 4
                    really is the cap.
  max_instances=1   one instance in total, so the cap holds across the site and
                    not merely within one process.

This is a deliberate trade. The site will queue rather than scale, and one
8,768-Khasra bulk run will block other visitors while it works. That is the
right way round for this app: the portal is a shared public service, and the
whole point of the limiter is to stay a polite client of it. Raise these only
if you have decided that throughput matters more than the cap, and understand
that the real portal load is `concurrency * BATCH_CONCURRENCY * instances`.


Timeout
-------

540s is the maximum for a 2nd-gen HTTP function. The largest measured bulk run
is 8,768 Khasras at about 65s, so there is a wide margin, and the client has a
matching wait of its own. There is no queued-job fallback: under
RATE_APP_SERVERLESS the job queue is off and /api/batch/run is synchronous,
which is what makes the whole run fit inside one request at all.
"""

import os
import sys

# Must be set before app.py is imported, because app.py reads it at module
# level. Serverless mode switches off the three things that assume a process
# which stays alive: the nightly refresh (its boot-time staleness check would
# find an empty cache on every cold start and re-walk all 1,070 lists, roughly
# 2,300 portal calls, per request), the in-memory job queue, and the SQLite
# history database.
os.environ.setdefault("RATE_APP_SERVERLESS", "1")

# The Functions Framework adds the function directory to sys.path, but relying
# on that is how a deploy works on one machine and fails on another. The path
# is fixed explicitly.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from a2wsgi import ASGIMiddleware  # noqa: E402
from firebase_functions import https_fn  # noqa: E402

import wsgi_bridge  # noqa: E402
from app import app as fastapi_app  # noqa: E402

# ASGI (FastAPI) -> WSGI callable, the direction the Functions Framework needs.
# It runs the app on its own event loop in a daemon thread, so this is safe to
# build at import time and is created once per instance, not once per request.
_wsgi = ASGIMiddleware(fastapi_app)


@https_fn.on_request(
    timeout_sec=540,
    memory="512MiB",
    concurrency=1,
    max_instances=1,
)
def api(req: https_fn.Request) -> https_fn.Response:
    """Handle any request that Firebase Hosting rewrites to this function.

    Firebase Hosting rewrites `/api/**` and `/health` here, so this one
    function answers the whole API. The browser then calls it on the same
    origin as the page, which is what finally gets around the portal's missing
    CORS headers: the request to the portal is made by this process, not by
    the browser.

    `req` is a Flask request and carries the WSGI environ the Functions
    Framework already built, so there is nothing to reconstruct from it. No
    route matching happens here -- FastAPI does that, on the real path.
    """
    status, headers, body = wsgi_bridge.call(_wsgi, req.environ)
    return https_fn.Response(body, status=status, headers=headers)
