#!/usr/bin/env bash
# Deploys one image to the server over SSH. The GitHub workflow runs this file
# unchanged, and so does the CMS repository's own deploy test.
#
# Everything arrives as environment variables:
#   DEPLOY_HOST, DEPLOY_USER, DEPLOY_PATH   where the stack lives
#   DEPLOY_PORT                             optional, default 22
#   PLAKBOEK_IMAGE                          the image to run, pushed beforehand
#   SSH_KEY_FILE, KNOWN_HOSTS_FILE          the deploy key and the pinned host key
#   REGISTRY_HOST, REGISTRY_USER, REGISTRY_TOKEN
#                                           optional; log the server in to the
#                                           registry before it pulls
#
# On the server, in this order and stopping at the first failure: pull the
# image, start Postgres, run the one-off migration, then recreate the app and
# the proxy. A failed migration therefore leaves the running app untouched.
set -euo pipefail

: "${DEPLOY_HOST:?DEPLOY_HOST is required}"
: "${DEPLOY_USER:?DEPLOY_USER is required}"
: "${DEPLOY_PATH:?DEPLOY_PATH is required}"
: "${PLAKBOEK_IMAGE:?PLAKBOEK_IMAGE is required}"
: "${SSH_KEY_FILE:?SSH_KEY_FILE is required}"
: "${KNOWN_HOSTS_FILE:?KNOWN_HOSTS_FILE is required}"
DEPLOY_PORT="${DEPLOY_PORT:-22}"

# Values end up inside a command that the server's shell parses, so each one
# must match a conservative pattern before it is used.
validate() {
  local name="$1" pattern="$2" value="${!1}"
  if [[ ! "$value" =~ $pattern ]]; then
    echo "FATAL: $name holds characters this script does not accept." >&2
    exit 1
  fi
}
validate DEPLOY_HOST '^[A-Za-z0-9.:-]+$'
validate DEPLOY_PORT '^[0-9]{1,5}$'
validate DEPLOY_USER '^[A-Za-z_][A-Za-z0-9_-]*$'
validate DEPLOY_PATH '^/[A-Za-z0-9._/-]+$'
validate PLAKBOEK_IMAGE '^[A-Za-z0-9][A-Za-z0-9._/:@-]*$'

SSH_OPTIONS=(
  -i "$SSH_KEY_FILE"
  -p "$DEPLOY_PORT"
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$KNOWN_HOSTS_FILE"
  -o GlobalKnownHostsFile=/dev/null
  -o ConnectTimeout=20
)
remote() {
  ssh "${SSH_OPTIONS[@]}" "$DEPLOY_USER@$DEPLOY_HOST" "$@"
}

COMPOSE_FILE_LOCAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/compose.yaml"

echo "==> Copying compose.yaml to $DEPLOY_HOST:$DEPLOY_PATH"
remote "cat > '$DEPLOY_PATH/compose.yaml'" < "$COMPOSE_FILE_LOCAL"

if [ -n "${REGISTRY_TOKEN:-}" ]; then
  : "${REGISTRY_HOST:?REGISTRY_HOST is required with REGISTRY_TOKEN}"
  : "${REGISTRY_USER:?REGISTRY_USER is required with REGISTRY_TOKEN}"
  validate REGISTRY_HOST '^[A-Za-z0-9.:-]+$'
  validate REGISTRY_USER '^[A-Za-z0-9._-]+$'
  echo "==> Logging $DEPLOY_HOST in to $REGISTRY_HOST"
  # The token travels on stdin, never on a command line.
  printf '%s' "$REGISTRY_TOKEN" \
    | remote "docker login '$REGISTRY_HOST' -u '$REGISTRY_USER' --password-stdin"
fi

echo "==> Deploying $PLAKBOEK_IMAGE"
remote "cd '$DEPLOY_PATH' \
  && export PLAKBOEK_IMAGE='$PLAKBOEK_IMAGE' \
  && docker compose -f compose.yaml pull app \
  && docker compose -f compose.yaml up -d --wait postgres \
  && docker compose -f compose.yaml run --rm migrate \
  && docker compose -f compose.yaml up -d --wait app caddy" < /dev/null

echo "==> Deployed $PLAKBOEK_IMAGE"
