#!/usr/bin/env bash
# Shared helper, sourced by scripts/verify-scaffold.sh and the deploy proof.
# Not executable on its own.
#
#   scaffold_host <work_dir> [--registry <version>]
#
# Creates <work_dir>/site, a Plakboek host, and sets SCAFFOLD_SITE_DIR to it.
#
# Tarball mode (default, D-20a): builds the workspace, packs every package,
# runs the PACKED create-plakboek, points every @plakboek/* dependency at the
# tarball packed from this checkout, and installs. Nothing is read from the
# workspace or the registry for the CMS packages.
#
# Registry mode (--registry <version>, D-20b): runs create-plakboek@<version>
# from npm exactly as a developer would, installing from the registry. A
# freshly published version can be missing from a lagging registry edge, so an
# install that fails with ERR_PNPM_NO_MATCHING_VERSION is retried in the
# created site on a fixed backoff; any other failure fails at once.

_SCAFFOLD_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_SCAFFOLD_REPO_ROOT="$(cd "$_SCAFFOLD_LIB_DIR/../.." && pwd)"

SCAFFOLD_SITE_NAME="Scaffold Proof"
SCAFFOLD_SITE_DIR=""

# Seconds to wait before each registry-mode install retry. The schedule starts
# at two minutes because a lagging CDN edge takes at least that long to refresh
# a cached package document, and it sums to 14 minutes.
_SCAFFOLD_INSTALL_RETRY_DELAYS="120 180 240 300"

# _scaffold_run_logged <log> <dir> <command...>
#
# Runs the command in <dir>, streaming its combined output to the console while
# a copy goes to <log>, and returns the command's own exit status. The status
# is read from PIPESTATUS inside an if-condition, where errexit is suspended,
# so the result is the same whether or not the caller set errexit and pipefail.
_scaffold_run_logged() {
  local log="$1" dir="$2" rc=0
  shift 2
  if (cd "$dir" && "$@") 2>&1 | tee "$log"; rc="${PIPESTATUS[0]}"; [ "$rc" -eq 0 ]; then
    return 0
  fi
  return "$rc"
}

# _scaffold_retry_registry_install <work_dir>
#
# Retries `pnpm install` in the created site while the registry still lacks a
# version the site depends on, then formats exactly as the CLI does after its
# own install.
_scaffold_retry_registry_install() {
  local work_dir="$1"
  local delays=($_SCAFFOLD_INSTALL_RETRY_DELAYS)
  local total="${#delays[@]}"
  local total_seconds=0 delay attempt=0 log
  for delay in "${delays[@]}"; do
    total_seconds=$((total_seconds + delay))
  done

  for delay in "${delays[@]}"; do
    attempt=$((attempt + 1))
    echo "==> A released version is not on the registry yet; retrying the install in ${delay}s (attempt $attempt of $total)"
    sleep "$delay"
    # pnpm keeps cached package metadata for a freshness window, so drop the
    # first-party entries or the retry could reuse the stale document that
    # just failed. A failure to delete is tolerated.
    (cd "$SCAFFOLD_SITE_DIR" && pnpm cache delete '@plakboek/*' < /dev/null) \
      || echo "WARN: could not clear the cached @plakboek/* metadata; continuing" >&2
    log="$work_dir/install-retry-$attempt.log"
    if _scaffold_run_logged "$log" "$SCAFFOLD_SITE_DIR" pnpm install --no-frozen-lockfile; then
      # The CLI formats the files after its own install; do the same.
      (cd "$SCAFFOLD_SITE_DIR" && pnpm run format > /dev/null)
      return 0
    fi
    if ! grep -q ERR_PNPM_NO_MATCHING_VERSION "$log"; then
      echo "FATAL: pnpm install failed on retry $attempt for a reason other than a missing version (see above)" >&2
      return 1
    fi
  done

  echo "FATAL: a released version was still missing from the registry after $total retries over $((total_seconds / 60)) minutes" >&2
  return 1
}

scaffold_host() {
  local work_dir="${1:?scaffold_host needs a work directory}"
  shift
  local registry_version=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --registry)
        registry_version="${2:?--registry needs a version}"
        shift 2
        ;;
      *)
        echo "FATAL: scaffold_host: unknown argument '$1'" >&2
        return 1
        ;;
    esac
  done

  SCAFFOLD_SITE_DIR="$work_dir/site"
  local create_args=(site --yes --site-name "$SCAFFOLD_SITE_NAME" --locale en --locales nl)

  if [ -n "$registry_version" ]; then
    echo "==> Scaffolding from create-plakboek@$registry_version on the registry"
    local cli_log="$work_dir/create-plakboek.log"
    if _scaffold_run_logged "$cli_log" "$work_dir" \
      npx --yes "create-plakboek@$registry_version" "${create_args[@]}"; then
      return 0
    fi
    if [ ! -f "$SCAFFOLD_SITE_DIR/package.json" ] \
      || ! grep -q ERR_PNPM_NO_MATCHING_VERSION "$cli_log"; then
      echo "FATAL: create-plakboek@$registry_version failed for a reason other than a missing version (see above)" >&2
      return 1
    fi
    _scaffold_retry_registry_install "$work_dir"
    return
  fi

  local tarball_dir="$work_dir/tarballs"
  mkdir -p "$tarball_dir"

  echo "==> Building workspace"
  (cd "$_SCAFFOLD_REPO_ROOT" && pnpm -r run build)

  echo "==> Packing every workspace package"
  # name|file pairs for every package except the CLI, which is only run.
  local overrides=""
  local pkg_json pkg_dir name version base
  for pkg_json in "$_SCAFFOLD_REPO_ROOT"/packages/*/package.json; do
    pkg_dir="$(dirname "$pkg_json")"
    name="$(node -p "require('$pkg_json').name")"
    version="$(node -p "require('$pkg_json').version")"
    pnpm --dir "$pkg_dir" pack --pack-destination "$tarball_dir" > /dev/null
    if [ "$name" != "create-plakboek" ]; then
      base="${name#@}"
      overrides="${overrides}  '${name}': 'file:./vendor/${base//\//-}-${version}.tgz'"$'\n'
    fi
  done

  local cli_tarball
  cli_tarball="$(ls "$tarball_dir"/create-plakboek-*.tgz)"

  echo "==> Scaffolding from the packed create-plakboek"
  (cd "$work_dir" && npx --yes --package "$cli_tarball" create-plakboek "${create_args[@]}" --skip-install)

  echo "==> Pointing every @plakboek/* package at its packed tarball"
  mkdir -p "$SCAFFOLD_SITE_DIR/vendor"
  for tarball in "$tarball_dir"/plakboek-*.tgz; do
    cp "$tarball" "$SCAFFOLD_SITE_DIR/vendor/"
  done
  {
    echo ""
    echo "# Added by scripts/lib/scaffold-host.sh for the fresh-install proof only:"
    echo "# every @plakboek/* package resolves to the tarball packed from this checkout."
    echo "overrides:"
    printf '%s' "$overrides"
  } >> "$SCAFFOLD_SITE_DIR/pnpm-workspace.yaml"

  echo "==> Installing dependencies"
  (cd "$SCAFFOLD_SITE_DIR" && pnpm install --no-frozen-lockfile)
  # The CLI formats the substituted files after its own install; do the same.
  (cd "$SCAFFOLD_SITE_DIR" && pnpm run format > /dev/null)
}
