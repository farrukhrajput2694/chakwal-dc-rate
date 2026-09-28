# Deploying to Firebase (Cloud Functions + Hosting)

This runs the **existing** FastAPI app (`app.py`, `govapi.py`) on Google's
servers so nothing has to be running on your machine. The site and the API land
on the same hostname, so the browser talks to `/api/...` on its own origin —
which is the thing that finally gets around the portal's missing CORS headers.

Nothing in `app.py` or `govapi.py` is modified for this. Only `functions/main.py`
is new, and it is a thin adapter.

---

## Before you start: two things you do **not** need

The config you pasted is the **client-side Firebase web SDK** config. This app
does not use it.

- **No `initializeApp` / `getAnalytics` in the front end.** The page is plain
  HTML and talks to `/api/...` over `fetch`. Adding the JS SDK would not make
  it work; the CORS problem is about who calls the *Punjab portal*, and that
  caller is now this function.
- **No Realtime Database.** The `*-default-rtdb.firebaseio.com` URL is the
  default for every new project. Nothing here reads or writes it. You do not
  need to create it, and you should not wire it up.
- The `apiKey` in a web config is designed to be public and grants no access by
  itself — but it does not belong in a repository, so it is not used anywhere
  here. Please do not paste **admin** credentials or service-account keys here.

---

## One-time setup

**1. Enable billing.** Cloud Functions will not deploy on the free "Spark"
plan — you need **Blaze** (pay-as-you-go). Add a card, then set a budget
alert. This app is close to free: a handful of visitors a day costs pennies, and
the portal calls are the only real cost. If you are not comfortable with a card
on file, the offline build on the Desktop is the alternative and needs none of
this.

**2. Install the CLI** (Node is already present, v26.8.1):

```powershell
npm install -g firebase-tools
```

If `npm` is not on your PATH, download the standalone binary from
<https://firebase.google.com/docs/cli> instead.

**3. Log in.** This opens a browser window — I cannot do this part for you, and
you should not paste credentials into this chat.

```powershell
cd "<this folder>"
firebase login
```

**4. Point the CLI at your project.** `.firebaserc` is already set to
`dc-rate-calculator`, taken from the config you pasted. Confirm it:

```powershell
firebase use
```

---

## Deploy

```powershell
firebase deploy
```

Expect **5–10 minutes** the first time. Most of it is Cloud Functions building
a Python container in Google's cloud and pip-installing `requirements.txt`.
Later deploys, when only the static files change, take well under a minute.

`firebase deploy --only hosting` re-uploads just the three website files — that
is the fast path while iterating on the front end.

---

## Check it worked

```powershell
# 1. The function is alive
curl.exe https://dc-rate-calculator.web.app/health
#    -> {"ok":true,"tehsil":"Chakwal",...}

# 2. The browser can reach the API on the same origin
curl.exe https://dc-rate-calculator.web.app/api/units
#    -> {"area_units":["Acre","Kanal","Marla","SqFt"],...}

# 3. The one thing that cannot be checked until you try it: whether the
#    Punjab portal accepts a connection from Google's IP ranges.
curl.exe "https://dc-rate-calculator.web.app/api/qanoongoes?tehsilId=75"
#    -> a JSON list of Qanoongoes  =  portal reachable from Google
#    -> a timeout / 5xx             =  Google IPs are blocked, see below
```

Then open <https://dc-rate-calculator.web.app> and look up a real Khasra.

---

## If Google's IPs are blocked by the portal

This is genuinely unknown and I could not test it without your account. It was
equally unknown for EdgeOne, which is why the EdgeOne package in `../deploy/`
is still here as a second route.

If step 3 above fails, the options are a different host (the VPS route —
`Dockerfile` / `docker-compose.yml` at the top of the project) or a host whose
IP range the portal does not block. The blocker would be the network, not the
code: `deploy/` and `deploy-firebase/` both contain the same app.

---

## A deliberate choice you may want to change

`functions/main.py` pins **`concurrency=1` and `max_instances=1`**.

`app.py` caps portal traffic with a process-wide limiter of 4. Under uvicorn
that is a real global cap, because one process handles one request at a time.
Cloud Functions breaks that assumption: one instance process handles
`concurrency` simultaneous requests, *each* getting its own 4 portal calls. At
the default concurrency of 80, a single instance could have 320 requests in
flight at a government server. With both knobs at 1, the in-app cap of 4 is
genuinely the cap.

**The cost:** visitors queue instead of scaling, and one 8,768-Khasra bulk run
blocks other visitors while it works (about 65s). For a small personal tool that
is the right way round, because the limiter exists precisely to be a polite
client of a shared public service.

Raising it is a one-line change, but the real portal load is
`concurrency x 4 x instances`. Do it only having decided that throughput matters
more than the cap.

---

## Testing the adapter without Firebase

`functions/wsgi_bridge.py` can be run on its own, with no Firebase account and
no network listener:

```powershell
cd functions
..\..\.venv\Scripts\python.exe wsgi_bridge.py
```

It drives the real app through the real ASGI-to-WSGI bridge and checks eight
things: GET, POST, query strings, request bodies, FastAPI's own 422
validation, a **live portal call**, serverless mode being on, and response
headers. This is the part of the deployment most likely to break silently, and
it is the part that can be verified from a plain terminal.

If that test passes and the deploy still fails, the problem is in Firebase's
configuration, not in the bridge.
