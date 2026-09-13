#!/usr/bin/env bash
# Publishability proof (D-19, Pitfall 6): build the workspace, pack each
# package, verify the tarball's contents and manifest, install the tarballs
# into a throwaway consumer project that lives OUTSIDE the pnpm workspace,
# import the public API at runtime, and type-check against it with the
# workspace's own TypeScript. Prints "publishable: OK" as its last line on
# success.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

TARBALL_DIR="$WORK_DIR/tarballs"
mkdir -p "$TARBALL_DIR"

cd "$REPO_ROOT"

echo "==> Building workspace"
pnpm -r run build

echo "==> Packing every workspace package"
for pkg_json in packages/*/package.json; do
  pkg_dir="$(dirname "$pkg_json")"
  # pnpm pack (not npm pack) rewrites catalog:/workspace: specifiers to real
  # published-manifest versions -- that rewrite is exactly what we verify below.
  pnpm --dir "$pkg_dir" pack --pack-destination "$TARBALL_DIR"
done

echo "==> Verifying tarball contents"
for tarball in "$TARBALL_DIR"/*.tgz; do
  tarball_name="$(basename "$tarball")"

  while IFS= read -r entry; do
    case "$entry" in
      package/package.json | package/README.md | package/LICENSE | package/dist/*) ;;
      *)
        echo "FATAL: unexpected tarball entry '$entry' in $tarball_name" >&2
        exit 1
        ;;
    esac
  done < <(tar -tzf "$tarball")

  packed_manifest="$(tar -xzOf "$tarball" package/package.json)"
  if printf '%s' "$packed_manifest" | grep -Eq '"[^"]+"[[:space:]]*:[[:space:]]*"(catalog|workspace):'; then
    echo "FATAL: packed manifest in $tarball_name contains a catalog: or workspace: specifier" >&2
    echo "$packed_manifest" >&2
    exit 1
  fi
done

echo "==> Creating throwaway non-workspace consumer"
CONSUMER_DIR="$WORK_DIR/consumer"
mkdir -p "$CONSUMER_DIR"
cat > "$CONSUMER_DIR/package.json" << 'EOF'
{
  "name": "publishable-consumer",
  "private": true,
  "type": "module",
  "version": "0.0.0"
}
EOF

echo "==> Installing packed tarballs into the consumer"
(
  cd "$CONSUMER_DIR"
  npm install --no-audit --no-fund --ignore-scripts "$TARBALL_DIR"/*.tgz
)

echo "==> Copying consumer probes"
cp "$REPO_ROOT"/scripts/publishable-consumer/* "$CONSUMER_DIR/"

cat > "$CONSUMER_DIR/tsconfig.json" << 'EOF'
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "ES2023",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": false,
    "types": []
  },
  "include": ["*.ts"]
}
EOF

echo "==> Type-checking consumer probes against the packed types"
"$REPO_ROOT/node_modules/.bin/tsc" -p "$CONSUMER_DIR/tsconfig.json"

echo "==> Running consumer probes at runtime"
for probe in "$CONSUMER_DIR"/*.mjs; do
  node "$probe"
done

echo "publishable: OK"
