#!/usr/bin/env bash
# Deploy proof (D-05, INFRA-04, INFRA-05): scaffold a host from the packed
# packages, build its image, push it to a local registry and run the project's
# own scripts/deploy.sh against a throwaway SSH + Docker target container. No
# real server is involved. The checks:
#
#   - two migrations started together both succeed and apply each migration once
#   - the deploy brings the site up: the home page and /cms/health through Caddy
#   - the first-run window is observed: /cms/setup answers 200 right after the
#     first deploy and 404 once the documented bootstrap has run
#   - the first-admin command in the scaffolded DEPLOY.md runs as written, over a
#     fresh SSH session with nothing exported, and creates the superadmin
#   - the server's environment file records the deployed image after a successful
#     deploy and keeps the previous one after a failed deploy; every other line
#     is untouched and the file stays mode 600; a plain compose command in a
#     fresh session resolves the deployed image
#   - a failed migration aborts the deploy and leaves the old app running
#   - a deploy while requests arrive every 100 ms shows no error (no 502)
#
# Needs Docker with the Compose plugin and network access for the base images.
# Prints "deploy: OK" as its last line on success.
#
#   bash scripts/verify-deploy.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/scaffold-host.sh
source "$SCRIPT_DIR/lib/scaffold-host.sh"

RUN_ID="$$"
WORK_DIR="$(mktemp -d)"
PROJECT="proof-$RUN_ID"
BOX_DIR="/home/deploy/$PROJECT"
REGISTRY_NAME="plakboek-proof-registry-$RUN_ID"
TARGET_NAME="plakboek-proof-target-$RUN_ID"
TARGET_IMAGE="plakboek-proof-target:$RUN_ID"
PROBE_PID=""
TARGET_STARTED=""

free_port() {
  node -e "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})"
}

fail() {
  echo "FATAL: $*" >&2
  exit 1
}

cleanup() {
  local status=$?
  set +e
  if [ -n "$PROBE_PID" ]; then
    kill "$PROBE_PID" 2> /dev/null
    wait "$PROBE_PID" 2> /dev/null
  fi
  if [ -n "$TARGET_STARTED" ]; then
    box "cd '$BOX_DIR' && docker compose -f compose.yaml down --volumes --remove-orphans" > /dev/null 2>&1
  fi
  # Whatever the target could not remove, the daemon can.
  local id
  for id in $(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT"); do
    docker rm -f "$id" > /dev/null 2>&1
  done
  for id in $(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT"); do
    docker volume rm -f "$id" > /dev/null 2>&1
  done
  for id in $(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT"); do
    docker network rm "$id" > /dev/null 2>&1
  done
  docker rm -f -v "$TARGET_NAME" "$REGISTRY_NAME" > /dev/null 2>&1
  docker rmi -f "$TARGET_IMAGE" "${IMAGE_1:-none}" "${IMAGE_2:-none}" > /dev/null 2>&1
  rm -rf "$WORK_DIR"
  exit "$status"
}
trap cleanup EXIT

docker info > /dev/null 2>&1 || fail "Docker is not available"
docker compose version > /dev/null 2>&1 || fail "the Docker Compose plugin is not available"

REGISTRY_PORT="$(free_port)"
SSH_PORT="$(free_port)"
HTTP_PORT="$(free_port)"
HTTPS_PORT="$(free_port)"
IMAGE_1="127.0.0.1:$REGISTRY_PORT/plakboek-proof-site:ci1"
IMAGE_2="127.0.0.1:$REGISTRY_PORT/plakboek-proof-site:ci2"
KEY_FILE="$WORK_DIR/deploy_key"
KNOWN_HOSTS_FILE="$WORK_DIR/known_hosts"

# Runs a command on the throwaway target as the deploy user, like the workflow.
box() {
  ssh -F /dev/null -i "$KEY_FILE" -p "$SSH_PORT" \
    -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$KNOWN_HOSTS_FILE" -o GlobalKnownHostsFile=/dev/null \
    -o LogLevel=ERROR deploy@127.0.0.1 "$@"
}

# Compose with an exported image, for the steps before any deploy has recorded one.
compose_on_box() {
  local image="$1"
  shift
  box "cd '$BOX_DIR' && export PLAKBOEK_IMAGE='$image' && docker compose -f compose.yaml $*"
}

# Compose in a fresh session with nothing exported, as an operator runs it: the
# image comes from the file the deploy maintains.
compose_fresh() {
  box "cd '$BOX_DIR' && docker compose -f compose.yaml $*"
}

run_deploy() {
  local image="$1"
  DEPLOY_HOST=127.0.0.1 DEPLOY_PORT="$SSH_PORT" DEPLOY_USER=deploy \
    DEPLOY_PATH="$BOX_DIR" PLAKBOEK_IMAGE="$image" \
    SSH_KEY_FILE="$KEY_FILE" KNOWN_HOSTS_FILE="$KNOWN_HOSTS_FILE" \
    bash "$SCAFFOLD_SITE_DIR/scripts/deploy.sh"
}

http_code() {
  curl --silent --max-time 20 --output /dev/null --write-out '%{http_code}' "$1" || true
}

cd "$REPO_ROOT"

echo "==> (1) Scaffolding a host from the packed packages"
scaffold_host "$WORK_DIR"

echo "==> (2) Building and pushing the image to a local registry"
docker run --detach --name "$REGISTRY_NAME" --publish "127.0.0.1:$REGISTRY_PORT:5000" registry:2 > /dev/null
for _ in $(seq 1 60); do
  curl --silent --fail --output /dev/null "http://127.0.0.1:$REGISTRY_PORT/v2/" && break
  sleep 0.5
done
curl --silent --fail --output /dev/null "http://127.0.0.1:$REGISTRY_PORT/v2/" \
  || fail "the local registry did not start"
for sha in ci1 ci2; do
  docker build --build-arg "GIT_SHA=$sha" --tag "127.0.0.1:$REGISTRY_PORT/plakboek-proof-site:$sha" "$SCAFFOLD_SITE_DIR"
  docker push "127.0.0.1:$REGISTRY_PORT/plakboek-proof-site:$sha" > /dev/null
done
# The box must pull from the registry, not find the image already present.
docker rmi "$IMAGE_1" "$IMAGE_2" > /dev/null

echo "==> (3) Starting the throwaway SSH + Docker target"
ssh-keygen -q -t ed25519 -N '' -C plakboek-deploy-proof -f "$KEY_FILE"
docker build --quiet --tag "$TARGET_IMAGE" "$SCRIPT_DIR/ci/ssh-target" > /dev/null
docker run --detach --name "$TARGET_NAME" \
  --publish "127.0.0.1:$SSH_PORT:22" \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --env "AUTHORIZED_KEY=$(cat "$KEY_FILE.pub")" \
  "$TARGET_IMAGE" > /dev/null
TARGET_STARTED=yes
for _ in $(seq 1 60); do
  ssh-keyscan -t ed25519 -p "$SSH_PORT" 127.0.0.1 > "$KNOWN_HOSTS_FILE" 2> /dev/null || true
  [ -s "$KNOWN_HOSTS_FILE" ] && break
  sleep 0.5
done
[ -s "$KNOWN_HOSTS_FILE" ] || fail "the target did not publish a host key"
for _ in $(seq 1 30); do
  box true 2> /dev/null && break
  sleep 0.5
done
box true || fail "could not log in to the target with the deploy key"
# Password login must be off.
if ssh -F /dev/null -p "$SSH_PORT" -o BatchMode=yes -o PubkeyAuthentication=no \
  -o UserKnownHostsFile="$KNOWN_HOSTS_FILE" -o GlobalKnownHostsFile=/dev/null \
  -o LogLevel=ERROR deploy@127.0.0.1 true 2> /dev/null; then
  fail "the target accepted a login without the key"
fi

echo "==> (4) Preparing the box: deploy directory, compose file and .env"
POSTGRES_PASSWORD="$(node -p "process.getBuiltinModule('node:crypto').randomBytes(18).toString('hex')")"
PLAKBOEK_SECRET="$(node -p "process.getBuiltinModule('node:crypto').randomBytes(32).toString('base64url')")"
box "mkdir -p '$BOX_DIR' && cat > '$BOX_DIR/compose.yaml'" < "$SCAFFOLD_SITE_DIR/compose.yaml"
cat > "$WORK_DIR/box.env" << EOF
POSTGRES_USER=plakboek
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=plakboek
DATABASE_URL=postgres://plakboek:$POSTGRES_PASSWORD@postgres:5432/plakboek
PLAKBOEK_URL=http://127.0.0.1:$HTTP_PORT
PLAKBOEK_SECRET=$PLAKBOEK_SECRET
PLAKBOEK_MAIL_FROM=no-reply@example.test
SITE_ADDRESS=:80
CADDY_HTTP_PORT=$HTTP_PORT
CADDY_HTTPS_PORT=$HTTPS_PORT
EOF
box "cat > '$BOX_DIR/.env' && chmod 600 '$BOX_DIR/.env'" < "$WORK_DIR/box.env"

echo "==> (5) Two migrations at once apply each migration exactly once"
compose_on_box "$IMAGE_1" "up -d --wait postgres" > /dev/null
compose_on_box "$IMAGE_1" "pull app" > /dev/null
compose_on_box "$IMAGE_1" "run --rm migrate" > "$WORK_DIR/migrate-a.log" 2>&1 &
PID_A=$!
compose_on_box "$IMAGE_1" "run --rm migrate" > "$WORK_DIR/migrate-b.log" 2>&1 &
PID_B=$!
STATUS_A=0
STATUS_B=0
wait "$PID_A" || STATUS_A=$?
wait "$PID_B" || STATUS_B=$?
cat "$WORK_DIR/migrate-a.log" "$WORK_DIR/migrate-b.log"
[ "$STATUS_A" = "0" ] || fail "the first concurrent migrate exited $STATUS_A"
[ "$STATUS_B" = "0" ] || fail "the second concurrent migrate exited $STATUS_B"
APPLYING="$(grep -h '^Applying ' "$WORK_DIR/migrate-a.log" "$WORK_DIR/migrate-b.log" | tr -d '\r' || true)"
[ -n "$APPLYING" ] || fail "neither concurrent migrate applied anything"
DUPLICATES="$(printf '%s\n' "$APPLYING" | sort | uniq -d)"
[ -z "$DUPLICATES" ] || fail "a migration was applied twice: $DUPLICATES"
EXPECTED_ROWS="$(printf '%s\n' "$APPLYING" | wc -l | tr -d ' ')"
ROWS="$(compose_on_box "$IMAGE_1" "exec -T postgres psql -U plakboek -d plakboek -At -c 'select count(*) from plakboek_migrations'" | tr -d '\r')"
[ "$ROWS" = "$EXPECTED_ROWS" ] \
  || fail "plakboek_migrations holds $ROWS rows, expected $EXPECTED_ROWS (one per applied migration)"
echo "    $EXPECTED_ROWS migration(s), each applied once"

echo "==> (6) deploy.sh deploys $IMAGE_1"
run_deploy "$IMAGE_1" || fail "scripts/deploy.sh exited non-zero for a healthy release"
SITE="http://127.0.0.1:$HTTP_PORT"
# The first-run window (D-09, accepted): open from the end of the first deploy
# until the first account exists.
[ "$(http_code "$SITE/cms/setup")" = "200" ] \
  || fail "$SITE/cms/setup is not 200 right after the first deploy"
IMAGES_AFTER_FIRST="$(compose_fresh "config --images" | tr -d '\r')"
printf '%s\n' "$IMAGES_AFTER_FIRST" | grep -qxF "$IMAGE_1" \
  || fail "a fresh-session compose does not resolve $IMAGE_1 after the deploy: $IMAGES_AFTER_FIRST"
if printf '%s\n' "$IMAGES_AFTER_FIRST" | grep -qxF "plakboek-app:local"; then
  fail "a fresh-session compose still resolves the default image after the deploy"
fi

echo "==> (7) The first-admin command from DEPLOY.md, then the site through Caddy"
PROOF_PASSWORD="$(node -p "process.getBuiltinModule('node:crypto').randomBytes(18).toString('base64url')")"
box 'test -z "${PLAKBOEK_IMAGE:-}"' || fail "a fresh session on the target already has PLAKBOEK_IMAGE set"
# The command comes from the scaffolded guide, not from this script: take the
# one fenced sh block that holds `plakboek bootstrap`, fill in the two
# placeholders the guide documents and run it over a fresh session.
cat > "$WORK_DIR/guide-command.cjs" << 'NODE'
const [file, deployPath, password] = process.argv.slice(2);
const text = require('node:fs').readFileSync(file, 'utf8');
const blocks = [];
let current = null;
for (const line of text.split('\n')) {
  if (current === null) {
    if (/^\s*```sh\s*$/.test(line)) current = [];
  } else if (/^\s*```\s*$/.test(line)) {
    blocks.push(current);
    current = null;
  } else {
    current.push(line);
  }
}
const hits = blocks.filter((block) => block.join('\n').includes('plakboek bootstrap'));
if (hits.length !== 1) {
  console.error(`DEPLOY.md holds ${hits.length} fenced sh blocks with 'plakboek bootstrap', expected exactly 1`);
  process.exit(1);
}
const lines = hits[0].filter((line) => line.trim() !== '');
const indent = Math.min(...lines.map((line) => line.length - line.trimStart().length));
const command = lines.map((line) => line.slice(indent)).join('\n');
if (!command.includes('cd /srv/site') || !command.includes("'the password'")) {
  console.error("the proof follows the guide's placeholders, cd /srv/site and 'the password', and DEPLOY.md no longer has them");
  process.exit(1);
}
process.stdout.write(
  command
    .replace('cd /srv/site', () => `cd '${deployPath}'`)
    .replace("'the password'", () => `'${password}'`),
);
NODE
BOOTSTRAP_COMMAND="$(node "$WORK_DIR/guide-command.cjs" "$SCAFFOLD_SITE_DIR/DEPLOY.md" "$BOX_DIR" "$PROOF_PASSWORD")" || fail "could not turn the DEPLOY.md first-admin block into a command"
echo "    running the command from DEPLOY.md:"
printf '%s\n' "${BOOTSTRAP_COMMAND//$PROOF_PASSWORD/<password>}" | sed 's/^/    | /'
BOOTSTRAP_OUTPUT="$(box "$BOOTSTRAP_COMMAND" < /dev/null)"
echo "$BOOTSTRAP_OUTPUT"
case "$BOOTSTRAP_OUTPUT" in
  *"Created superadmin "*) ;;
  *) fail "the DEPLOY.md command did not create the superadmin" ;;
esac
[ "$(http_code "$SITE/cms/setup")" = "404" ] || fail "$SITE/cms/setup is not 404 after the bootstrap"
[ "$(http_code "$SITE/cms/health")" = "200" ] || fail "$SITE/cms/health is not 200 through Caddy"
HOME_PAGE="$(curl --silent --max-time 20 "$SITE/")"
case "$HOME_PAGE" in
  *"Hello world"*) ;;
  *) fail "GET / through Caddy does not contain 'Hello world'" ;;
esac
[ "$(http_code "$SITE/")" = "200" ] || fail "GET / through Caddy is not 200"
APP_BEFORE="$(compose_fresh "ps -q app" | tr -d '\r')"
[ -n "$APP_BEFORE" ] || fail "no running app container after the deploy"
BUILD_BEFORE="$(box "docker exec $APP_BEFORE printenv PLAKBOEK_BUILD_ID" | tr -d '\r')"
[ "$BUILD_BEFORE" = "ci1" ] || fail "the app runs build id '$BUILD_BEFORE', expected ci1"
USER_BEFORE="$(box "docker exec $APP_BEFORE id -un" | tr -d '\r')"
[ "$USER_BEFORE" = "node" ] || fail "the app runs as '$USER_BEFORE', expected node"

echo "==> (8) A failed migration aborts the deploy and leaves the old app serving"
# Unreachable on purpose: the one-off migrate container reads it, the running
# app container does not.
box "printf '%s\n' 'DATABASE_MIGRATION_URL=postgres://nobody:nothing@127.0.0.1:1/none' >> '$BOX_DIR/.env'"
if run_deploy "$IMAGE_2"; then
  fail "scripts/deploy.sh exited 0 although the migration failed"
fi
APP_AFTER_FAILURE="$(compose_fresh "ps -q app" | tr -d '\r')"
[ "$APP_AFTER_FAILURE" = "$APP_BEFORE" ] \
  || fail "the app container changed after a failed migration ($APP_BEFORE -> $APP_AFTER_FAILURE)"
[ "$(box "docker inspect --format '{{.State.Running}}' $APP_BEFORE" | tr -d '\r')" = "true" ] \
  || fail "the old app container stopped after a failed migration"
[ "$(http_code "$SITE/")" = "200" ] || fail "GET / is not 200 after a failed migration"
RECORD_AFTER_FAILURE="$(box "grep '^PLAKBOEK_IMAGE=' '$BOX_DIR/.env'" | tr -d '\r')"
[ "$RECORD_AFTER_FAILURE" = "PLAKBOEK_IMAGE=$IMAGE_1" ] \
  || fail "the recorded image changed after a failed deploy: $RECORD_AFTER_FAILURE"
IMAGES_AFTER_FAILURE="$(compose_fresh "config --images" | tr -d '\r')"
printf '%s\n' "$IMAGES_AFTER_FAILURE" | grep -qxF "$IMAGE_1" \
  || fail "a fresh-session compose does not resolve $IMAGE_1 after a failed deploy: $IMAGES_AFTER_FAILURE"
if printf '%s\n' "$IMAGES_AFTER_FAILURE" | grep -qxF "$IMAGE_2"; then
  fail "a fresh-session compose resolves $IMAGE_2 after a failed deploy"
fi
box "sed -i '/^DATABASE_MIGRATION_URL=/d' '$BOX_DIR/.env'"
if box "grep -q DATABASE_MIGRATION_URL '$BOX_DIR/.env'"; then
  fail "could not remove the unreachable migration URL again"
fi

echo "==> (9) Deploying $IMAGE_2 while requests arrive every 100 ms"
PROBE_LOG="$WORK_DIR/probe.log"
: > "$PROBE_LOG"
(
  while true; do
    curl --silent --max-time 20 --output /dev/null --write-out '%{http_code}\n' "$SITE/" >> "$PROBE_LOG" || echo "000" >> "$PROBE_LOG"
    sleep 0.1
  done
) &
PROBE_PID=$!
sleep 1
run_deploy "$IMAGE_2" || fail "scripts/deploy.sh exited non-zero for the second release"
sleep 1
kill "$PROBE_PID" 2> /dev/null || true
wait "$PROBE_PID" 2> /dev/null || true
PROBE_PID=""
PROBES="$(wc -l < "$PROBE_LOG" | tr -d ' ')"
NOT_OK="$(grep -vc '^200$' "$PROBE_LOG" || true)"
[ "$PROBES" -gt 0 ] || fail "the probe recorded nothing"
[ "$NOT_OK" = "0" ] \
  || fail "$NOT_OK of $PROBES probes during the deploy were not 200: $(grep -v '^200$' "$PROBE_LOG" | sort | uniq -c | tr '\n' ' ')"
APP_AFTER="$(compose_fresh "ps -q app" | tr -d '\r')"
[ -n "$APP_AFTER" ] && [ "$APP_AFTER" != "$APP_BEFORE" ] || fail "the app container was not recreated"
BUILD_AFTER="$(box "docker exec $APP_AFTER printenv PLAKBOEK_BUILD_ID" | tr -d '\r')"
[ "$BUILD_AFTER" = "ci2" ] || fail "the app runs build id '$BUILD_AFTER' after the deploy, expected ci2"
[ "$(http_code "$SITE/cms/health")" = "200" ] || fail "$SITE/cms/health is not 200 after the second deploy"
RECORDS="$(box "grep '^PLAKBOEK_IMAGE=' '$BOX_DIR/.env'" | tr -d '\r')"
[ "$RECORDS" = "PLAKBOEK_IMAGE=$IMAGE_2" ] \
  || fail ".env does not hold exactly one PLAKBOEK_IMAGE line naming $IMAGE_2: $RECORDS"
OTHER_LINES="$(box "grep -v '^PLAKBOEK_IMAGE=' '$BOX_DIR/.env'" | tr -d '\r')"
[ "$OTHER_LINES" = "$(cat "$WORK_DIR/box.env")" ] \
  || fail "the deploy changed lines of .env other than PLAKBOEK_IMAGE"
ENV_MODE="$(box "stat -c %a '$BOX_DIR/.env'" | tr -d '\r')"
[ "$ENV_MODE" = "600" ] || fail ".env has mode $ENV_MODE after the deploy, expected 600"
if box "test -e '$BOX_DIR/.env.next'"; then
  fail "the deploy left .env.next behind"
fi
IMAGES_AFTER_SECOND="$(compose_fresh "config --images" | tr -d '\r')"
printf '%s\n' "$IMAGES_AFTER_SECOND" | grep -qxF "$IMAGE_2" \
  || fail "a fresh-session compose does not resolve $IMAGE_2 after the second deploy: $IMAGES_AFTER_SECOND"
echo "    $PROBES probes during the deploy, all 200"

echo "deploy: OK"
