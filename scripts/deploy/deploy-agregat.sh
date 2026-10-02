#!/usr/bin/env bash
# Production deploy of discover.nulife.pl on agregat (PC-00 / PC-36).
#
# The versioned successor of the operator's ~/deploy-discover.sh (WSL),
# which becomes a one-line wrapper:
#     exec ~/projects/lead-discovery-platform/scripts/deploy/deploy-agregat.sh "$@"
#
# What it does, over one SSH session (docker-compose v1 syntax — agregat has
# the hyphenated binary only — and always both compose files):
#   1. git pull of the deployed branch in /opt/lead-discovery-platform
#   2. `config -q`: the compose files must validate under the server's
#      docker-compose before anything is built or stopped
#   3. build the image once (the `app` service; `worker` runs the same
#      image tag), with BUILD_SHA for /api/ready
#   4. optional (--migrate): host-side `pnpm db:migrate`, before the new
#      code starts (migrations are additive; the image has no tsx)
#   5. recreate app (ROLE=web) and worker (ROLE=worker); postgres and redis
#      are left alone (--no-deps)
#   6. status of both containers, the worker's first log lines, and
#      /api/health on the loopback port
#
# Usage:
#   scripts/deploy/deploy-agregat.sh              # deploy origin/main
#   scripts/deploy/deploy-agregat.sh --migrate    # also apply migrations
#   scripts/deploy/deploy-agregat.sh --dry-run    # print the remote script, run nothing
# Environment overrides: DEPLOY_HOST (root@195.201.16.169),
# DEPLOY_DIR (/opt/lead-discovery-platform), DEPLOY_BRANCH (main).
#
# Every step is its own line in the remote script (no wrapped && chains),
# and the remote shell runs with `set -euo pipefail`, so the first failing
# step stops the deploy with the old containers still running.
set -euo pipefail

HOST="${DEPLOY_HOST:-root@195.201.16.169}"
APP_DIR="${DEPLOY_DIR:-/opt/lead-discovery-platform}"
BRANCH="${DEPLOY_BRANCH:-main}"
DRY_RUN=0
MIGRATE=0

usage() {
  sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --migrate) MIGRATE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

for value in "$APP_DIR" "$BRANCH"; do
  case "$value" in
    *[!A-Za-z0-9._/-]*|'') echo "refusing unsafe DEPLOY_DIR / DEPLOY_BRANCH: $value" >&2; exit 2 ;;
  esac
done

remote_script() {
  cat <<REMOTE
set -euo pipefail
cd ${APP_DIR}
COMPOSE="docker-compose -f docker-compose.yml -f docker-compose.prod.yml"
echo "=== git pull ==="
git pull origin ${BRANCH}
export BUILD_SHA=\$(git rev-parse --short HEAD)
echo "=== deploying \${BUILD_SHA} ==="
echo "=== compose config ==="
\$COMPOSE --profile app config -q
echo "=== build app (the worker runs the same image) ==="
\$COMPOSE build app 2>&1 | tail -40
REMOTE
  if [ "$MIGRATE" = 1 ]; then
    cat <<'REMOTE'
echo "=== migrate (host-side) ==="
pnpm db:migrate
REMOTE
  fi
  cat <<'REMOTE'
echo "=== up -d app worker ==="
$COMPOSE up -d --no-build --force-recreate --no-deps app worker
echo "=== status ==="
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep -E -- '[-_](app|worker)[-_]'
echo "=== worker log ==="
sleep 5
$COMPOSE logs --tail=20 worker
echo "=== health ==="
curl -fsS --retry 10 --retry-delay 3 --retry-connrefused http://127.0.0.1:3001/api/health
echo
REMOTE
}

if [ "$DRY_RUN" = 1 ]; then
  echo "# ssh ${HOST} 'bash -s' <<REMOTE"
  remote_script
  exit 0
fi

ssh -o StrictHostKeyChecking=accept-new \
    -o ServerAliveInterval=20 \
    -o ServerAliveCountMax=30 \
    "$HOST" 'bash -s' <<<"$(remote_script)"
