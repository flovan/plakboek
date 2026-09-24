# Releasing `@plakboek/*`

This document describes how the `@plakboek/*` packages reach the public
npm registry. The publish list is every non-private package under
`packages/`, derived from the workspace by
`scripts/release/publish-unpublished.ts` -- currently `auth`, `content`,
`db`, and `permissions`. `@plakboek/permissions` and `@plakboek/db` are
additionally versioned together as one Changesets `fixed` group
(`.changeset/config.json`), so those two always ship at the same version
while the others version independently.

## Steady state

1. A change under `packages/` carries a changeset (`pnpm changeset`), as
   required by CI's `changesets` job (see `CONTRIBUTING.md`).
2. The change merges to `main`.
3. `.github/workflows/release.yml`'s `version` job runs `pnpm run
release:version` (`changeset version && pnpm install --no-frozen-lockfile`)
   via `changesets/action@v1` and opens or updates a pull request titled
   **"Version packages"** with the version bump, changelog entries, and
   `.changeset/*.md` files consumed. The `version` job's own output,
   `hasChangesets`, tells the rest of the workflow whether that PR is still
   open (`true`) or whether every pending changeset has already been
   consumed (`false`).
4. **The "Version packages" PR itself shows no status checks.** Pull
   requests opened with the default `GITHUB_TOKEN` do not trigger other
   workflows on GitHub -- this is a GitHub Actions security restriction, not
   a bug in this pipeline. Review the PR's diff (version bumps,
   `CHANGELOG.md` entries) directly; CI already ran on the commit(s) that
   went into it before they merged to `main`.
5. Merging the "Version packages" PR is itself a push to `main` with no
   pending changesets. That push runs the reusable `ci` workflow
   (`.github/workflows/ci.yml`) end-to-end on the merge commit, then, only
   if `ci` succeeds, runs the `publish` job: `node
scripts/release/publish-unpublished.ts`, which packs each package with
   `pnpm pack`, validates the packed manifest (no leftover `catalog:` /
   `workspace:` specifiers, exact `repository.url`), and publishes with
   `npm publish --access public --provenance` under OIDC trusted
   publishing -- no `NPM_TOKEN` secret is stored or used anywhere in this
   repository.
6. A package/version already on npm is skipped automatically -- the publish
   job is safe to re-run (`workflow_dispatch`) after a partial failure.

## Bootstrap: a package that has never been published

npm's trusted-publisher configuration can only be attached to a package
that already exists on the registry -- there is no way to configure OIDC
trust for a name that has never been published. The very first publish of
any `@plakboek/*` package is therefore a one-time, human-performed,
classic-auth action, done once per package, before the automated pipeline
above can take over for it.

`scripts/release/publish-unpublished.ts` detects this case on its own: for
a package with no version on npm at all, it prints a `::warning::`
annotation pointing back at this document and reports the package as
`bootstrap-required` in its summary line -- it never attempts to publish
that package itself.

To bootstrap a package (maintainer only, requires account-level 2FA on the
npm account -- classic auth, not a token), run these commands from the
repo root:

```sh
pnpm run build
pnpm --dir packages/<name> pack --pack-destination "$PWD/.release-bootstrap"
npm publish .release-bootstrap/plakboek-<name>-<version>.tgz \
  --access public --provenance=false
```

The `pack` destination above is an absolute path. `pnpm pack
--pack-destination` resolves a relative value against the packed package's
own directory, not the repo root -- a relative `.release-bootstrap` lands
the tarball in `packages/<name>/.release-bootstrap/`, while the `npm
publish` line above resolves paths from the repo root and fails with a
`tarball data for file:... seems to be corrupted` error.

`--provenance=false` overrides `publishConfig.provenance: true`, which
every published manifest sets and which is correct for the automated
`release.yml` publish -- that one runs under GitHub Actions OIDC trusted
publishing and needs the attestation it produces. A bootstrap publish is
human-run locally with no OIDC provider, so without the override npm
aborts with `EUSAGE`:
`Automatic provenance generation not supported for provider: null`.
The accepted consequence: the bootstrap tarball ships with no provenance
attestation, while every subsequent release of that package, published by
`release.yml`, has one.

Run the publish from an interactive terminal so npm's web-based 2FA flow
can open a browser tab for you to approve. In a non-interactive shell (CI
runner, piped command, etc.) the web flow cannot complete and `npm publish`
fails with `EOTP`; pass a current TOTP code directly instead:
`npm publish <tarball> --access public --provenance=false --otp=<code>`.
If you use the npmjs.com website fallback below, its publish-permission
dialog must have **"npm publish"** checked as an allowed action for the
trusted publisher to actually be able to publish later.

Then bind the newly published package to this repository's release
workflow as a trusted publisher. `npm trust` requires npm `>=11.15.0` and,
since 2026-05-20, the registry rejects the command without an explicit
permission flag -- the local npm floor for this repo (11.12.1) is too old,
so invoke a current npm via `npx`:

```sh
npx -y npm@11.19.1 trust github @plakboek/<name> --file release.yml --repository flovan/plakboek --allow-publish --yes
```

Verify the binding (also requires npm `>=11.15.0`):

```sh
npx -y npm@11.19.1 trust list @plakboek/<name>
```

`npm trust list` prompts for a one-time password even to read the current
configuration -- it cannot be run non-interactively (e.g. from CI or an
automated agent). Run it from an interactive terminal and complete the
OTP/web-auth prompt.

If `npm trust github` is refused or unavailable, configure the same
relationship from the npm website instead: open the package on npmjs.com,
**Settings -> Trusted Publisher -> GitHub Actions**, and set:

- **Organization or user:** `flovan`
- **Repository:** `plakboek`
- **Workflow filename:** `release.yml`
- **Environment:** (leave empty)

Once every publishable package has been bootstrapped and trusted, remove
the `.release-bootstrap/` directory -- it is a scratch location, not a
committed artifact.

## Required repository setting

The `version` job opens pull requests using the workflow's own
`GITHUB_TOKEN`. GitHub only allows a workflow to do this if the repository
setting **Settings -> Actions -> General -> Workflow permissions -> Allow
GitHub Actions to create and approve pull requests** is enabled:

```sh
gh api -X PUT repos/flovan/plakboek/actions/permissions/workflow \
  -f default_workflow_permissions=read \
  -F can_approve_pull_request_reviews=true
```

Without this setting, the `version` job's `changesets/action@v1` step fails
to open the "Version packages" PR.

## Troubleshooting

**`npm publish` fails with `E404 Not Found` even though the package exists
and OIDC/provenance appeared to succeed.** This is the signature of an open
upstream bug (`npm/cli#8976`) affecting scoped packages published via
OIDC trusted publishing in some configurations. Re-run the `publish` job
(`workflow_dispatch` on `release.yml`) -- `publish-unpublished.ts` is
idempotent and will skip any package/version that did land on the
registry, so a retry only affects packages that actually failed.

**The publish job fails with a message about the npm version floor.**
Trusted publishing requires npm `>=11.5.1`. The `publish` job runs on Node
24 specifically (not the Node 22 used everywhere else in CI) because Node
22 LTS bundles an older npm; if this check ever fails, npm itself changed
its floor or Node 24's bundled version regressed -- add an explicit `npm
install -g npm@latest` step to the job rather than lowering the check.

**`npm trust` fails with `E400`.** Since 2026-05-20 the registry requires
an explicit permission flag (`--allow-publish`) on `npm trust github`, and
the command itself needs npm `>=11.15.0` -- older than the trusted-publish
floor above. `E400` from `npm trust` means either the flag is missing or
the npm binary running the command predates 11.15.0; run it via
`npx -y npm@11.19.1 trust github ...` as shown in the bootstrap section
rather than the repo's pinned/local npm.

## Deferred follow-up

Third-party GitHub Actions referenced in `release.yml` and `ci.yml` are
pinned by major version tag (e.g. `actions/checkout@v7`), not commit SHA.
This is an explicit, accepted Phase 1 decision (see the threat model's
T-01-48 entry) -- SHA-pinning every action is a supply-chain hardening
follow-up for a later phase, not in scope here.
