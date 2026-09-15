# @plakboek/permissions

## 0.2.0

## 0.1.2

### Patch Changes

- [`1d784cf`](https://github.com/flovan/plakboek/commit/1d784cf0c654759215e26670ba8447ef78915a3c) Thanks [@flovan](https://github.com/flovan)! - Fix `@plakboek/db`'s README to stop documenting `withMigrationLock` as an
  importable export, guard `withMigrationLock` so a failed advisory-unlock
  query can no longer discard a successful migration result, and align both
  packages' `engines.node` floor with the workspace's own requirement.

## 0.1.1

### Patch Changes

- [#1](https://github.com/flovan/plakboek/pull/1) [`4b1b215`](https://github.com/flovan/plakboek/commit/4b1b215347e72667ac5c84a651d2de6828fd7d4e) Thanks [@flovan](https://github.com/flovan)! - Publish with npm provenance attestations from the release workflow.
