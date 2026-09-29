# @plakboek/pages

## 0.2.0

### Minor Changes

- [#11](https://github.com/flovan/plakboek/pull/11) [`2122689`](https://github.com/flovan/plakboek/commit/21226894af83a1715f5a8b887e44eb5115c5a49d) Thanks [@flovan](https://github.com/flovan)! - Complete the page and block-tree engine: the public barrel exposes the full
  block/field/widget registry, the page hierarchy and URL pattern, the block
  tree with placement and depth rules, schema versioning and compaction,
  per-block revisions and restore, publish and draft snapshots, locales and
  the locale purge, and page edit locking -- documented as a host-facing
  registration contract in the README.

- [#11](https://github.com/flovan/plakboek/pull/11) [`e5a85ad`](https://github.com/flovan/plakboek/commit/e5a85ad8de97fe3bdc013bee899b1a78c20bad32) Thanks [@flovan](https://github.com/flovan)! - Add the @plakboek/pages package scaffold with its real-Postgres integration
  test harness.

### Patch Changes

- Updated dependencies [[`f3b3682`](https://github.com/flovan/plakboek/commit/f3b368200d7df12f2ff9835b3aed8ca157a3d1d1), [`9f8f7a7`](https://github.com/flovan/plakboek/commit/9f8f7a7ef835bd9a6645d531f69ad73b3a334f2a), [`74d9ad8`](https://github.com/flovan/plakboek/commit/74d9ad820f0233a967b741cae735165237763d81)]:
  - @plakboek/content@0.3.0
  - @plakboek/db@0.4.0
  - @plakboek/auth@0.2.2
  - @plakboek/permissions@0.4.0
