#!/bin/bash
# Central Intelligence — first-boot setup for Google Cloud e2-micro (1 GB RAM).
#
# Run as root on a fresh Ubuntu 24.04 Minimal VM:
#   curl -fsSL https://raw.githubusercontent.com/Joshuv-AI/central-intelligence/main/ops/gcp-setup.sh | sudo bash
#
# Idempotent: safe to re-run. GCP's VPC firewall already allows 80/443
# (set at VM creation); Ubuntu Minimal ships with no host firewall.
#
# What it does:
#   - 2 GB swapfile — the 1 GB box needs it. The Vite/Cesium frontend build
#     spikes well past 1 GB; swap lets it finish instead of OOM-killing.
#   - Docker Engine + Compose v2 (official Docker apt repo)
#   - Docker log rotation (10 MB x 3 files) so logs can't fill the 30 GB disk
#   - Fetches the repo (tarball — minimal images lack rsync), installs
#     ci-pull/ci-deploy, enables the 5-minute self-update cron
#   - fail2ban + unattended-upgrades
set -u

REPO_DIR="/opt/central-intelligence"
log() { echo "[gcp-setup] $*"; }

# --- Swap ---
if ! swapon --show=NAME 2>/dev/null | grep -q '^/swapfile$'; then
  log "creating 2 GB swapfile"
  if ! fallocate -l 2G /swapfile 2>/dev/null; then
    dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  fi
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  log "swap active: $(free -m | awk '/^Swap:/ {print $2}') MB"
else
  log "swap already active"
fi
grep -q '^/swapfile ' /etc/fstab 2>/dev/null || echo "/swapfile none swap sw 0 0" >> /etc/fstab

# --- Base packages ---
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q curl git cron fail2ban unattended-upgrades

# --- Docker Engine + Compose v2 ---
if ! command -v docker >/dev/null 2>&1; then
  log "installing Docker Engine"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
systemctl enable --now docker
docker --version
docker compose version

# --- Log rotation: cap container logs so they can't fill the 30 GB disk ---
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
systemctl restart docker

# --- App code (tarball sync: no rsync/git dependency on minimal images) ---
if [ ! -f "$REPO_DIR/docker-compose.yml" ]; then
  log "fetching repo tarball"
  mkdir -p "$REPO_DIR"
  curl -sL -m 120 "https://github.com/Joshuv-AI/central-intelligence/archive/main.tar.gz" -o /tmp/repo.tar.gz
  tar xzf /tmp/repo.tar.gz -C /tmp
  cp -a /tmp/central-intelligence-main/. "$REPO_DIR/"
  rm -rf /tmp/repo.tar.gz /tmp/central-intelligence-main
fi
install -m 0755 "$REPO_DIR/ops/ci-deploy" /usr/local/bin/ci-deploy
install -m 0755 "$REPO_DIR/ops/ci-pull" /usr/local/bin/ci-pull
install -m 0755 "$REPO_DIR/ops/ci-diagnostic-server.py" /usr/local/bin/ci-diagnostic-server.py

# --- Self-update cron (every 5 min; all future deploys = git push) ---
printf '%s\n' '*/5 * * * * root /usr/local/bin/ci-pull' > /etc/cron.d/ci-pull
chmod 0644 /etc/cron.d/ci-pull
systemctl enable --now cron

# --- Hardening basics ---
systemctl enable --now fail2ban
systemctl enable unattended-upgrades || true

# --- First deploy (build takes several minutes on e2-micro; swap carries it) ---
# Seed the deploy SHA first: otherwise this manual deploy builds with
# GIT_SHA=unknown and ci-pull then sees SHA_FILE==REMOTE_SHA and never
# corrects the label. (Seen on first GCP boot 2026-09-28.)
export GIT_SHA=$(curl -s -m 15 "https://api.github.com/repos/Joshuv-AI/central-intelligence/commits/main" | grep -o '"sha": "[0-9a-f]*"' | head -1 | cut -d'"' -f4)
if [ -n "$GIT_SHA" ]; then
  echo "$GIT_SHA" > /var/lib/ci-deployed-sha
  log "deploy SHA: ${GIT_SHA:0:12}"
else
  log "WARNING: could not fetch deploy SHA; deploying as unknown"
fi
log "first deploy starting"
if /usr/local/bin/ci-deploy; then
  log "DEPLOY OK — app healthy"
else
  log "deploy exited $?: diagnostic page may be on :80 — see /var/log/ci-build.log"
fi
