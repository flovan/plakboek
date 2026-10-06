#!/usr/bin/env bash
# Fresh-install proof (D-20a, INST-01): pack every package, scaffold a host
# from the PACKED create-plakboek into a directory outside the workspace,
# install every @plakboek/* from the packed tarballs, then typecheck, lint,
# format-check, build, migrate, bootstrap and serve the site, and fetch the
# seeded home page. Prints "scaffold: OK" as its last line on success.
#
#   TEST_DATABASE_URL=postgres://... bash scripts/verify-scaffold.sh
#   TEST_DATABASE_URL=postgres://... bash scripts/verify-scaffold.sh --registry 0.1.0
#
# The second form (D-20b) scaffolds from the npm registry instead, for the
# post-release check. The database named by SCAFFOLD_DATABASE_URL (or
# TEST_DATABASE_URL) is only an admin connection: a throwaway database is
# created on it and dropped again.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/scaffold-host.sh
source "$SCRIPT_DIR/lib/scaffold-host.sh"

REGISTRY_VERSION=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --registry)
      REGISTRY_VERSION="${2:?--registry needs a version}"
      shift 2
      ;;
    *)
      echo "usage: verify-scaffold.sh [--registry <version>]" >&2
      exit 2
      ;;
  esac
done

SCAFFOLD_ADMIN_URL="${SCAFFOLD_DATABASE_URL:-${TEST_DATABASE_URL:-}}"
if [ -z "$SCAFFOLD_ADMIN_URL" ]; then
  echo "FATAL: set SCAFFOLD_DATABASE_URL or TEST_DATABASE_URL (see .env.example)" >&2
  exit 1
fi
export SCAFFOLD_ADMIN_URL

WORK_DIR="$(mktemp -d)"
SERVER_PID=""
DB_NAME=""

cleanup() {
  local status=$?
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2> /dev/null; then
    kill "$SERVER_PID" 2> /dev/null || true
    wait "$SERVER_PID" 2> /dev/null || true
  fi
  if [ -n "$DB_NAME" ]; then
    node "$SCRIPT_DIR/lib/create-database.ts" drop "$DB_NAME" || true
  fi
  rm -rf "$WORK_DIR"
  exit "$status"
}
trap cleanup EXIT

fail() {
  echo "FATAL: $*" >&2
  exit 1
}

cd "$REPO_ROOT"

if [ -n "$REGISTRY_VERSION" ]; then
  scaffold_host "$WORK_DIR" --registry "$REGISTRY_VERSION"
else
  scaffold_host "$WORK_DIR"
fi

cd "$SCAFFOLD_SITE_DIR"

for script in typecheck lint format:check; do
  echo "==> pnpm run $script"
  pnpm run "$script"
done

echo "==> pnpm run build"
NODE_ENV=production pnpm run build

echo "==> Creating a throwaway database"
DATABASE_URL="$(node "$SCRIPT_DIR/lib/create-database.ts" create)"
DB_NAME="${DATABASE_URL##*/}"

PORT="$(node -e "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})")"
BASE_URL="http://127.0.0.1:$PORT"

# Written, never sourced: values such as the mail From address hold < and >.
{
  echo "DATABASE_URL=$DATABASE_URL"
  echo "PLAKBOEK_URL=$BASE_URL"
  echo "PLAKBOEK_MAIL_FROM=no-reply@example.test"
} > .env
pnpm --silent secret >> .env

echo "==> plakboek migrate"
MIGRATE_OUTPUT="$(pnpm plakboek migrate)"
echo "$MIGRATE_OUTPUT"
case "$MIGRATE_OUTPUT" in
  *"Applying 0001_auth_core"*) ;;
  *) fail "migrate did not print 'Applying 0001_auth_core'" ;;
esac

echo "==> plakboek bootstrap"
# Generated per run and passed on stdin, never on the command line.
PROOF_PASSWORD="$(node -p "process.getBuiltinModule('node:crypto').randomBytes(18).toString('base64url')")"
BOOTSTRAP_OUTPUT="$(printf '%s' "$PROOF_PASSWORD" | pnpm plakboek bootstrap --name "Scaffold Proof" --email proof@example.test --password-stdin)"
echo "$BOOTSTRAP_OUTPUT"
case "$BOOTSTRAP_OUTPUT" in
  *"Created superadmin proof@example.test."*) ;;
  *) fail "bootstrap did not create the superadmin" ;;
esac
case "$BOOTSTRAP_OUTPUT" in
  *"Published the home page at /."*) ;;
  *) fail "bootstrap did not publish the home page" ;;
esac

echo "==> Starting the production server on $BASE_URL"
NODE_ENV=production PORT="$PORT" HOST=127.0.0.1 node --env-file=.env server.ts > "$WORK_DIR/server.log" 2>&1 &
SERVER_PID=$!

READY=""
for _ in $(seq 1 60); do
  if ! kill -0 "$SERVER_PID" 2> /dev/null; then
    cat "$WORK_DIR/server.log" >&2
    fail "the server exited before it became healthy"
  fi
  if curl --silent --fail --output /dev/null "$BASE_URL/cms/health"; then
    READY=yes
    break
  fi
  sleep 0.5
done
if [ -z "$READY" ]; then
  cat "$WORK_DIR/server.log" >&2
  fail "/cms/health did not answer within 30 seconds"
fi

echo "==> Fetching the seeded home page"
HEADERS="$WORK_DIR/home.headers"
BODY="$WORK_DIR/home.html"
STATUS="$(curl --silent --output "$BODY" --dump-header "$HEADERS" --write-out '%{http_code}' "$BASE_URL/")"
[ "$STATUS" = "200" ] || fail "GET / answered $STATUS, expected 200"
grep -q 'Hello world' "$BODY" || fail "GET / does not contain 'Hello world'"
SCRIPTS="$(grep -o '<script' "$BODY" | wc -l | tr -d ' ')"
[ "$SCRIPTS" = "1" ] || fail "GET / holds $SCRIPTS <script tags, expected exactly 1"
tr -d '\r' < "$HEADERS" | grep -qi '^cache-control: public, max-age=0, must-revalidate$' \
  || fail "GET / has an unexpected Cache-Control header"
ETAG="$(tr -d '\r' < "$HEADERS" | sed -n 's/^[Ee][Tt][Aa][Gg]: //p' | head -n 1)"
[ -n "$ETAG" ] || fail "GET / has no ETag"
CONDITIONAL="$(curl --silent --output /dev/null --write-out '%{http_code}' --header "If-None-Match: $ETAG" "$BASE_URL/")"
[ "$CONDITIONAL" = "304" ] || fail "a conditional GET / answered $CONDITIONAL, expected 304"

for path in /cms/setup /no-such-page; do
  CODE="$(curl --silent --output /dev/null --write-out '%{http_code}' "$BASE_URL$path")"
  [ "$CODE" = "404" ] || fail "GET $path answered $CODE, expected 404"
done

echo "scaffold: OK"
