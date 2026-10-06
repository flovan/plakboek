#!/usr/bin/env bash
# Fresh-install proof (D-20a, INST-01): pack every package, scaffold a host
# from the PACKED create-plakboek into a directory outside the workspace,
# install every @plakboek/* from the packed tarballs, then typecheck, lint,
# format-check, migrate, run the development server (404 hint, bootstrap,
# stylesheet, live reload after a block edit and a template edit), then build,
# serve the production site and check the page, chrome, stylesheet and error
# pages. Prints "scaffold: OK" as its last line on success.
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
DEV_PID=""
DB_NAME=""

# `pnpm dev` runs react-router and Vite as children, so stop the whole tree.
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2> /dev/null || true); do
    kill_tree "$child"
  done
  kill "$pid" 2> /dev/null || true
}

stop_process() {
  local pid="$1"
  if [ -n "$pid" ] && kill -0 "$pid" 2> /dev/null; then
    kill_tree "$pid"
    wait "$pid" 2> /dev/null || true
  fi
}

cleanup() {
  local status=$?
  stop_process "$SERVER_PID"
  stop_process "$DEV_PID"
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

wait_for_health() {
  local pid="$1" log_file="$2" label="$3"
  local ready=""
  for _ in $(seq 1 120); do
    if ! kill -0 "$pid" 2> /dev/null; then
      cat "$log_file" >&2
      fail "the $label exited before it became healthy"
    fi
    if curl --silent --fail --output /dev/null "$BASE_URL/cms/health"; then
      ready=yes
      break
    fi
    sleep 0.5
  done
  if [ -z "$ready" ]; then
    cat "$log_file" >&2
    fail "/cms/health did not answer within 60 seconds ($label)"
  fi
}

echo "==> Starting the development server on $BASE_URL"
pnpm dev --port "$PORT" --strictPort --host 127.0.0.1 > "$WORK_DIR/dev.log" 2>&1 &
DEV_PID=$!
wait_for_health "$DEV_PID" "$WORK_DIR/dev.log" "development server"

echo "==> Before bootstrap: GET / is the 404 page with the development hint"
CODE="$(curl --silent --max-time 120 --output "$WORK_DIR/dev404.html" --write-out '%{http_code}' "$BASE_URL/")"
[ "$CODE" = "404" ] || fail "development GET / before bootstrap answered $CODE, expected 404"
grep -q 'No home page yet' "$WORK_DIR/dev404.html" \
  || fail "the development 404 on / does not show the home page hint"

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

echo "==> Development loop: theme, stylesheet and reload after edits"
node "$SCRIPT_DIR/lib/dev-loop-check.ts" "$BASE_URL" "$SCAFFOLD_SITE_DIR" \
  || fail "the development loop check failed"

echo "==> Stopping the development server"
stop_process "$DEV_PID"
DEV_PID=""

echo "==> pnpm run build"
NODE_ENV=production pnpm run build

echo "==> Starting the production server on $BASE_URL"
NODE_ENV=production PORT="$PORT" HOST=127.0.0.1 node --env-file=.env server.ts > "$WORK_DIR/server.log" 2>&1 &
SERVER_PID=$!

wait_for_health "$SERVER_PID" "$WORK_DIR/server.log" "production server"

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

echo "==> Checking the chrome, theme and error pages"
grep -Eq '<a href="/"[^>]*>Scaffold Proof</a>' "$BODY" \
  || fail "the header does not link the site name to /"
grep -q '<nav aria-label="Main">' "$BODY" || fail "the header has no Main nav"
grep -Eq 'aria-current="page"[^>]*>Home</a>' "$BODY" \
  || fail "the Home link is not marked aria-current=\"page\" on /"
grep -q '<nav aria-label="Footer">' "$BODY" || fail "the footer has no Footer nav"
grep -q "© $(date +%Y) Scaffold Proof" "$BODY" \
  || fail "the footer does not show the copyright line"

CSS_HREF="$(sed -n 's/.*<link rel="stylesheet" href="\([^"]*\)".*/\1/p' "$BODY" | head -n 1)"
case "$CSS_HREF" in
  /assets/*.css) ;;
  *) fail "the stylesheet link '$CSS_HREF' does not point into /assets/" ;;
esac
CSS_HEADERS="$WORK_DIR/stylesheet.headers"
CSS_CODE="$(curl --silent --output /dev/null --dump-header "$CSS_HEADERS" --write-out '%{http_code}' "$BASE_URL$CSS_HREF")"
[ "$CSS_CODE" = "200" ] || fail "GET $CSS_HREF answered $CSS_CODE, expected 200"
tr -d '\r' < "$CSS_HEADERS" | grep -qi '^content-type: text/css' \
  || fail "GET $CSS_HREF is not served as text/css"
tr -d '\r' < "$CSS_HEADERS" | grep -qi '^cache-control: public, max-age=31536000, immutable$' \
  || fail "GET $CSS_HREF does not carry the immutable cache header"

ROBOTS="$(curl --silent "$BASE_URL/robots.txt")"
case "$ROBOTS" in
  *"Disallow: /cms"*) ;;
  *) fail "/robots.txt does not disallow /cms" ;;
esac

CODE="$(curl --silent --output "$WORK_DIR/notfound.html" --write-out '%{http_code}' "$BASE_URL/no-such-page")"
[ "$CODE" = "404" ] || fail "GET /no-such-page answered $CODE, expected 404"
grep -q 'Page not found' "$WORK_DIR/notfound.html" || fail "the production 404 does not say 'Page not found'"
if grep -q 'No home page yet' "$WORK_DIR/notfound.html"; then
  fail "the production 404 shows the development hint"
fi

CODE="$(curl --silent --output /dev/null --write-out '%{http_code}' "$BASE_URL/cms/setup")"
[ "$CODE" = "404" ] || fail "GET /cms/setup answered $CODE, expected 404"

echo "scaffold: OK"
