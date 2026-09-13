# Contributing to Plakboek

Thanks for taking a look. This repository holds the core `@plakboek/*`
packages -- not a customer site -- so contributions here affect every
installation that depends on them.

## Local setup

Requirements: Node `>=22.18` and pnpm (the exact version is pinned via the
`packageManager` field in the root `package.json`; `corepack enable` will
pick it up automatically).

```sh
docker compose up -d --wait postgres   # local Postgres, used by @plakboek/db's integration tests
cp .env.example .env
pnpm install
```

Useful root scripts:

```sh
pnpm run build             # tsdown build for every package
pnpm run test              # unit tests
pnpm run test:integration  # integration tests against real Postgres (needs the container above)
pnpm run typecheck         # tsc --noEmit for every package
pnpm run lint              # type-aware oxlint (--type-aware --deny-warnings)
pnpm run format             # oxfmt, writes changes
pnpm run format:check       # oxfmt, checks only
pnpm run check               # publint + attw per package
pnpm run verify:publishable  # pack every package, install into a throwaway non-workspace consumer, type-check and import it at runtime
```

## Code style

Formatting is enforced by `oxfmt` (`.oxfmtrc.json`): 2-space indentation, no
tabs, single quotes, trailing commas everywhere, 80-column print width.
`pnpm run format:check` runs in CI; `pnpm run format` writes the fix. Linting
is `oxlint --type-aware --deny-warnings` (`.oxlintrc.json`), including
type-aware TypeScript rules -- `type` aliases over `interface`, `Record<>`
over index signatures, no floating/misused promises, and vitest-authoring
rules for the test suites. A rule violation you genuinely need to keep needs
a line-level `// oxlint-disable-next-line <rule> -- <reason>` comment, not a
config-wide disable.

## Changesets

Every change under `packages/` must carry a changeset:

```sh
pnpm changeset
```

All `@plakboek/*` packages are versioned together as one **fixed** group
(Changesets `fixed`) -- a change to one bumps the version of all of them
together, so they never drift apart. While the packages are below `1.0.0`,
a minor version bump may include breaking changes; pin an exact version if
you need stability.

CI's `changesets` job fails a branch or pull request that touches
`packages/` without an accompanying changeset (`.changeset/*.md`).

## Permission catalogue and role policy

The permission catalogue exported by `@plakboek/permissions` is a published
contract every host's role configuration depends on: it cannot be extended
or renamed per installation, only referenced. See
[`packages/permissions/README.md`](./packages/permissions/README.md) --
particularly its "Stability policy" section -- before proposing a change to
`PERMISSIONS` or a permission string's name.

## Database migrations

Every migration `@plakboek/db` ships (and every migration a host adds on
top of it) follows the authoring convention documented in
[`packages/db/MIGRATIONS.md`](./packages/db/MIGRATIONS.md): forward-only,
statically registered by explicit import (never a directory scan),
existence-guarded DDL so a partially applied migration can be re-run
cleanly, and immutable once shipped.

## What CI runs

Every push (any branch) and every pull request runs:

- **quality** -- build, typecheck, lint, format check
- **unit** -- unit tests
- **integration** -- unit + integration tests against a real `postgres:17`
  service container, including the migration partial-failure and
  concurrent-migrator proofs
- **packaging** -- `publint` + `attw`, and the pack-and-install
  publishability proof (`verify:publishable`)
- **changesets** -- fails if `packages/` changed without a changeset (skipped
  on pushes to `main`)

CI running against a forked pull request holds only `contents: read`
permissions and never references repository secrets -- untrusted code from a
fork cannot exfiltrate anything CI has access to.
