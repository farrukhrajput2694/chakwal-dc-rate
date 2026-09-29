#!/usr/bin/env bash
#
# Provision the Chakwal DC Rate Calculator on a VPS, running 24/7 with no
# dependency on your own machine.
#
# This is the only deployment target that actually satisfies "it must keep
# working when my PC is off". The free tiers do not:
#
#   Render free    sleeps after 15 minutes idle; the first request after that
#                  waits out a cold start.
#   Render starter  a container that is periodically recycled, so the in-process
#                  reference cache is destroyed and lookups are dead for about
#                  six minutes until all 1,070 lists are re-read.
#   EdgeOne /       same cold-start problem, and EdgeOne currently will not run
#   Firebase        this app's function at all.
#
# A VPS is a real machine that stays up, and the reference cache is built once
# and then held for the life of the process.
#
# Usage, on a fresh Ubuntu or Debian box:
#
#   git clone https://github.com/farrukhrajput2694/chakwal-dc-rate.git
#   cd chakwal-dc-rate
#   sudo ./deploy-vps.sh your-domain.example.com
#
# Before running this, the domain's DNS A record must already point at the
# server's public IP. Caddy gets its TLS certificate from Let's Encrypt over
# plain HTTP, so it cannot start until DNS resolves. The script checks this and
# stops rather than failing mysteriously later.
#
# To tear it down:  sudo docker compose -f /opt/chakwal/compose.yml down

set -euo pipefail

DOMAIN="${1:-${CHAKWAL_DOMAIN:-}}"
REPO="https://github.com/farrukhrajput2694/chakwal-dc-rate.git"
APP_DIR="/opt/chakwal"
COMPOSE="$APP_DIR/compose.yml"
# Generous, because a cold start re-reads all 1,070 reference lists.
HEALTH_TIMEOUT=900

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning: %s\033[0m\n' "$*"; }
die()  { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight --
[ "$(id -u)" -eq 0 ] || die "run as root, or with sudo"

# The domain is optional, and running without one is the better first move.
# Get the app answering on a plain IP, confirm a real rate lookup works, and
# only then add DNS and TLS. Doing it the other way round means a certificate
# or DNS mistake looks like an application fault, and those are hard to tell
# apart from six minutes of cold start. Re-run with the domain to switch over:
#   sudo ./deploy-vps.sh your-domain.example.com

if [ -z "$DOMAIN" ]; then
  log "no domain given - bringing the site up on a bare IP over plain HTTP"
  log "re-run later with a domain to add HTTPS: sudo ./deploy-vps.sh your-domain"
else
  # Oracle and other cloud images are minimal and often ship without dig, which
  # would make the DNS preflight below silently pass on an empty result.
  if ! command -v dig >/dev/null 2>&1; then
    apt-get update -qq 2>/dev/null && apt-get install -y -qq dnsutils >/dev/null 2>&1 || true
  fi
  PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
  if [ -z "$PUBLIC_IP" ]; then
    warn "could not determine this server's public IP; skipping the DNS check"
  else
    log "this server's public IP is $PUBLIC_IP"
    RESOLVED="$(dig +short "$DOMAIN" A 2>/dev/null | tail -n1 || true)"
    if [ -z "$RESOLVED" ]; then
      die "$DOMAIN does not resolve. Add an A record pointing at $PUBLIC_IP, then re-run.
       Let's Encrypt cannot issue a certificate for a name that does not resolve."
    fi
    if [ "$RESOLVED" != "$PUBLIC_IP" ]; then
      die "$DOMAIN resolves to $RESOLVED, but this server is $PUBLIC_IP.
       Fix the A record first, or Caddy will fail to get a certificate."
    fi
    log "$DOMAIN resolves to this server"
  fi
fi

# ------------------------------------------------------------------ docker --
if ! command -v docker >/dev/null 2>&1; then
  log "installing Docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg]" \
    "https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin \
                      docker-compose-plugin git
fi
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required but missing"
systemctl enable --now docker

# ------------------------------------------------------------------- fetch ---
log "fetching the application"
mkdir -p "$APP_DIR"
if [ -d "$APP_DIR/app/.git" ]; then
  git -C "$APP_DIR/app" pull --ff-only
else
  git clone --depth 1 "$REPO" "$APP_DIR/app"
fi
# The Dockerfile only needs these; dropping the rest keeps the image context
# small and stops desktop/ and web-project/ from being uploaded to the builder.
rm -rf "$APP_DIR/app/desktop" "$APP_DIR/app/web-project" "$APP_DIR/app/dist" \
       "$APP_DIR/app/build" "$APP_DIR/app/_loose-copies" "$APP_DIR/app/logs"

# ------------------------------------------------------------------ compose --
log "writing $COMPOSE"
# The app is deliberately NOT published to a host port. Caddy is the only
# service with a published port, so nothing but the reverse proxy is reachable
# from the internet. The app's own bind stays on the container network.
cat > "$COMPOSE" <<'YAML'
services:
  app:
    build:
      context: ./app
      dockerfile: Dockerfile
    container_name: chakwal-app
    restart: unless-stopped
    environment:
      PYTHONUNBUFFERED: "1"
      # Deliberately NOT RATE_APP_SERVERLESS. This container keeps one process
      # alive for its lifetime, so the nightly refresh, the queued bulk runs
      # and the SQLite history all work. Setting it would switch all three off.
      #
      # A wall-clock time in PAKISTAN time, not host-local time. 0 is midnight in
      # Chakwal, so the same value is correct on this UTC host.
      RATE_APP_REFRESH_HOUR: "0"
      RATE_APP_REFRESH_MINUTE: "0"
      # Empty: the page and the API share an origin, so CORS is not needed.
      RATE_APP_CORS_ORIGINS: ""
    # Deliberately no `ports:`. Caddy is the only way in.
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=4)"]
      interval: 30s
      timeout: 5s
      # Generous start period: a cold container is not useful for ~6 minutes
      # while it re-reads all 1,070 reference lists.
      start_period: 30m
      retries: 3

  proxy:
    image: caddy:2-alpine
    container_name: chakwal-proxy
    restart: unless-stopped
    depends_on:
      - app
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    environment:
      CHAKWAL_DOMAIN: ${CHAKWAL_DOMAIN}
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      # Certificates live here, outside the repo, and survive image rebuilds.
      - caddy-data:/data
      - caddy-config:/config

volumes:
  caddy-data:
  caddy-config:
YAML

# ------------------------------------------------------------------- caddy --
log "writing the Caddyfile"
mkdir -p "$APP_DIR/caddy"
if [ -n "$DOMAIN" ]; then
  # Caddy obtains and renews the certificate itself. The bare `:80` listener is
  # deliberate: it answers the HTTP-01 challenge that Let's Encrypt uses to prove
  # domain control, and redirects everything else to HTTPS.
  cat > "$APP_DIR/caddy/Caddyfile" <<'CADDY'
:80 {
    respond /.well-known/acme-challenge/* 200
    redir https://{host}{uri} permanent
}

{$CHAKWAL_DOMAIN} {
    encode zstd gzip
    # The app sets no-store on the frontend, so no caching is configured here.
    # Let the app answer, including its /health and /api/* routes, so there is
    # exactly one origin and no CORS to get wrong.
    reverse_proxy app:8000
}
CADDY
else
  # No domain yet: serve plain HTTP so the app can be proven working on its raw
  # IP before any certificate or DNS record enters the picture. `http://` is
  # explicit because Caddy would otherwise infer a hostname and try to issue a
  # certificate for an IP address, which Let's Encrypt will not do.
  cat > "$APP_DIR/caddy/Caddyfile" <<'CADDY'
http:// {
    encode zstd gzip
    reverse_proxy app:8000
}
CADDY
fi

# --------------------------------------------------------------- firewall --
if command -v ufw >/dev/null 2>&1; then
  log "opening 22, 80 and 443 in the firewall"
  ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  ufw --force enable >/dev/null
fi

# -------------------------------------------------------------------- up ---
log "building and starting (the first build pulls the Python base image)"
cd "$APP_DIR"
CHAKWAL_DOMAIN="$DOMAIN" docker compose -f "$COMPOSE" up -d --build

# Docker's `restart: unless-stopped` already brings the stack back after a
# reboot, because docker.service starts before it. Nothing else is needed, and
# a systemd unit would only duplicate that.

# The address to poll. With no domain this is the machine's own public IP over
# plain HTTP, which is how the first deployment is meant to be proven.
if [ -n "$DOMAIN" ]; then
  BASE="https://$DOMAIN"
else
  SELF_IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
  [ -n "$SELF_IP" ] || die "could not determine this server's public IP to poll"
  BASE="http://$SELF_IP"
fi

log "waiting for the first reference-list walk (and TLS, if a domain is set)"
printf '    this takes up to %s minutes on a cold start.\n' "$((HEALTH_TIMEOUT / 60))"
DEADLINE=$(( $(date +%s) + HEALTH_TIMEOUT ))
LAST=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if BODY="$(curl -fsS --max-time 10 "$BASE/health" 2>/dev/null)"; then
    RUNNING="$(printf '%s' "$BODY" | grep -o '"refresh_running":[a-z]*' | cut -d: -f2)"
    if [ "$RUNNING" = "False" ]; then
      printf '\n\033[32m    ready.\033[0m %s\n' "$BODY"
      break
    fi
    LAST="still walking the reference lists"
  else
    LAST="not answering yet (still building, or Caddy is getting its certificate)"
  fi
  printf '    %s\n' "$LAST"
  sleep 20
done

log "state"
docker compose -f "$COMPOSE" ps
printf '\n'
docker compose -f "$COMPOSE" logs --tail 15 app 2>&1 | sed 's/^/    /'

cat <<SUMMARY

--------------------------------------------------------------------------
 Site:    $BASE
 Health:  $BASE/health

 Survives reboot:  yes. Both services are 'restart: unless-stopped' and
                   docker.service starts on boot, so nothing re-registers.
                   This machine staying on is irrelevant to the site.

 Survives disk fill: no. If this machine's disk fills, the portal walk will
                   fail and lookups will stop. Worth a disk alert.

 Restarting after an update:
    cd $APP_DIR/app && git pull && cd $APP_DIR
    CHAKWAL_DOMAIN="$DOMAIN" docker compose -f $COMPOSE up -d --build

 One thing to expect: the reference lists live in the process, not on disk
 (app.py, "live and die with the process"). So if the container is ever
 restarted, the site is unusable for roughly six minutes while it re-reads
 all 1,070 lists -- about 2,300 calls to the government portal. The page
 still loads and looks correct throughout; only lookups fail. A real VM does
 not get recycled the way a container platform does, so this window should
 happen rarely. Persisting the cache to a volume is the fix, and is a change
 to app.py rather than to this script.
$([ -n "$DOMAIN" ] || cat <<NOSSL

 ---------------------------------------------------------------------
 This was brought up on a bare IP over plain HTTP, on purpose. Prove the
 app works before adding a certificate. Once a rate lookup returns the
 expected figure, add a domain and re-run to switch on HTTPS:

     sudo $APP_DIR/app/deploy-vps.sh your-domain.example.com

 For a free domain name, the DuckDNS record dcratecalculator.duckdns.org
 already exists. Point it at $SELF_IP by running duckdns-update.ps1 with
 -IpOverride, or set the A record where it is registered. Note that the
 hourly ChakwalDuckDns task on your PC will keep pushing the PC's own IP
 over anything you set by hand -- disable that task first with:

     Disable-ScheduledTask -TaskName ChakwalDuckDns
NOSSL
)
 Verify it properly, not just by the page loading. This lookup should return
 Rs 366,025 per acre:
    Mouza Alawal / Qanoongoee Balkassar / Agricultural / Link Road / Khasra 947
--------------------------------------------------------------------------
SUMMARY
