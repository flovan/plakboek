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
# from npm exactly as a developer would, installing from the registry.

_SCAFFOLD_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_SCAFFOLD_REPO_ROOT="$(cd "$_SCAFFOLD_LIB_DIR/../.." && pwd)"

SCAFFOLD_SITE_NAME="Scaffold Proof"
SCAFFOLD_SITE_DIR=""

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
    (cd "$work_dir" && npx --yes "create-plakboek@$registry_version" "${create_args[@]}")
    return 0
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
