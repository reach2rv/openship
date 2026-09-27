#!/bin/sh
# Deploy the reach2rv OpenShip panel (compose mode) on a fresh Ubuntu EC2 host.
#
#   PANEL_DOMAIN=panel.example.com sh scripts/deploy-panel.sh
#
# Optional env:
#   PANEL_DOMAIN           public hostname (A record → this host). Required for a
#                          publicly reachable panel; omit for loopback-only testing.
#   OPENSHIP_VERSION       pin image/CLI tag (default: latest fork release)
#   SKIP_DNS_CHECK=1       don't warn when the domain doesn't resolve here yet
#   FORCE=1                skip the interactive confirmation
#
# What it does:
#   1. Preflight: Ubuntu/systemd, ports 80+443 free (aaPanel/nginx conflict!),
#      RAM/disk, DNS
#   2. Installs Docker + compose plugin if missing (openship up would too)
#   3. Installs the openship CLI from this fork's GitHub releases
#   4. Runs `openship up` → Postgres+Redis+API+dashboard+OpenResty edge as
#      compose services, boot-persistent, admin created via the wizard
#
# AFTER this script: images must exist in ghcr.io/reach2rv (push a v*.*.* tag on
# deploy/main, see scripts/RELEASE-RUNBOOK.md). If the panel 403s/404s on pull,
# either make the GHCR packages public (GitHub → Packages → package settings) or
# `docker login ghcr.io` with a PAT that has read:packages.
set -eu

err() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; }
info() { printf '\033[36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$1" >&2; }

[ "$(id -u)" = "0" ] || { err "run as root (sudo -i)"; exit 1; }

# ── 1. Preflight ─────────────────────────────────────────────────────────────
if [ -f /etc/os-release ] && grep -qiE 'ubuntu|debian' /etc/os-release; then
  info "OS: $(. /etc/os-release; echo "${PRETTY_NAME:-unknown}")"
else
  warn "not Ubuntu/Debian — openship up targets Ubuntu; continuing anyway"
fi

command -v systemctl >/dev/null 2>&1 || { err "systemd is required (EC2 Ubuntu has it)"; exit 1; }

for port in 80 443; do
  if command -v ss >/dev/null 2>&1 && ss -ltn "( sport = :$port )" | grep -q LISTEN; then
    if ss -ltnp "( sport = :$port )" 2>/dev/null | grep -qiE 'nginx|aapanel|BT-Panel|httpd'; then
      err "port $port is held by an existing web server (aaPanel/nginx?). OpenShip's edge needs 80+443."
      err "  → deploy this panel on a FRESH instance, or stop/disable the other server first:"
      err "     systemctl stop nginx && systemctl disable nginx   (aaPanel: also disable its panel nginx)"
      exit 1
    fi
    warn "port $port is in use by an unknown process — openship up may fail to bind"
  fi
done

RAM_MB=$(free -m | awk '/^Mem:/{print $2}')
[ "${RAM_MB:-0}" -lt 1800 ] && warn "only ${RAM_MB}MB RAM — the compose stack (Postgres+Redis+API+dashboard+edge) wants 2GB+"
DISK_GB=$(df -m / | awk 'NR==2{print int($4/1024)}')
[ "${DISK_GB:-0}" -lt 10 ] && warn "only ${DISK_GB}GB free on / — images + Postgres want 10GB+"

PANEL_DOMAIN="${PANEL_DOMAIN:-}"
if [ -n "$PANEL_DOMAIN" ]; then
  PUBLIC_IP=$(curl -fsSL --max-time 10 https://checkip.amazonaws.com 2>/dev/null || true)
  DOMAIN_IP=$(getent hosts "$PANEL_DOMAIN" | awk '{print $1; exit}' || true)
  if [ -z "$DOMAIN_IP" ] || [ "$DOMAIN_IP" != "$PUBLIC_IP" ]; then
    warn "DNS: $PANEL_DOMAIN → ${DOMAIN_IP:-<no record>}, but this host's IP is ${PUBLIC_IP:-<unknown>}"
    [ "${SKIP_DNS_CHECK:-0}" = "1" ] || warn "  fix the A record (or set SKIP_DNS_CHECK=1) — TLS issuance will fail until it matches"
  fi
fi

if [ "${FORCE:-0}" != "1" ]; then
  printf 'Deploy OpenShip panel%s to this host? [y/N] ' "${PANEL_DOMAIN:+ at https://$PANEL_DOMAIN}"
  read -r answer
  case "$answer" in y|Y|yes|YES) ;; *) echo "aborted"; exit 1 ;; esac
fi

# ── 2. Docker ────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  info "Installing Docker…"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi
docker compose version >/dev/null 2>&1 || { err "docker compose plugin missing"; exit 1; }
info "Docker $(docker --version | awk '{print $3}' | tr -d ,)"

# ── 3. openship CLI from the fork's releases ────────────────────────────────
if command -v openship >/dev/null 2>&1; then
  info "openship CLI already present: $(openship --version 2>/dev/null || echo unknown)"
else
  info "Installing the openship CLI from reach2rv/openship releases…"
  curl -fsSL https://raw.githubusercontent.com/reach2rv/openship/deploy/main/scripts/install.sh | sh
fi

# ── 4. Bring the panel up ────────────────────────────────────────────────────
# Compose mode (Linux + Docker) hosts apps on this box with automatic domains
# + TLS. The wizard creates the admin, wires the domain, installs the boot service.
if [ -n "$PANEL_DOMAIN" ]; then
  openship up --public-url "https://$PANEL_DOMAIN" ${OPENSHIP_VERSION:+--image-version "$OPENSHIP_VERSION"}
else
  warn "no PANEL_DOMAIN — panel will be loopback-only; front it with your own proxy or re-run with a domain"
  openship up ${OPENSHIP_VERSION:+--image-version "$OPENSHIP_VERSION"}
fi

info "Done. Panel: ${PANEL_DOMAIN:+https://$PANEL_DOMAIN}"' (or http://<host>:3001 from the box)'
info "Useful: openship (control panel) · openship update · openship stop · docker compose logs -f api"
