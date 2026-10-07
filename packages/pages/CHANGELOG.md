# @plakboek/pages

## 0.5.0

### Patch Changes

- Updated dependencies [[`82a38b2`](https://github.com/flovan/plakboek/commit/82a38b24f8e5ccc59650b6986704d30d654c795a)]:
  - @plakboek/db@0.5.0
  - @plakboek/auth@0.5.0
  - @plakboek/content@0.5.0
  - @plakboek/cache@0.5.0
  - @plakboek/permissions@0.5.0

## 0.3.0

### Minor Changes

- [#13](https://github.com/flovan/plakboek/pull/13) [`59c3119`](https://github.com/flovan/plakboek/commit/59c311953f5f5e9c5bd2ac83c5af9adfa13b3097) Thanks [@flovan](https://github.com/flovan)! - `resolveVisitorPage` now returns an `invalid-pattern` resolution (carrying the `PageUrlPatternError`) when the stored page URL pattern no longer parses, for example one written before pattern literals were restricted, instead of throwing on every request.

- [#13](https://github.com/flovan/plakboek/pull/13) [`3153b25`](https://github.com/flovan/plakboek/commit/3153b25d7015c8c55f29c915ba90befda8f710b7) Thanks [@flovan](https://github.com/flovan)! - Every write that changes what a visitor can see (unpublish, trash, restore, permanent delete, move, rename, URL-pattern change, locale purge) now purges the cache after its transaction commits.

- [#13](https://github.com/flovan/plakboek/pull/13) [`1f6ad90`](https://github.com/flovan/plakboek/commit/1f6ad90ba7865da636e32124a9f63d6beeb0cb1f) Thanks [@flovan](https://github.com/flovan)! - `PagesDeps` accepts an optional `invalidator`, and `publishPage` purges the published page's cache tag after its transaction commits.

- [#13](https://github.com/flovan/plakboek/pull/13) [`74a4e66`](https://github.com/flovan/plakboek/commit/74a4e66ff2dc30d11e723ddff4aa5edcfe6539f6) Thanks [@flovan](https://github.com/flovan)! - A publication now freezes the page's `title` and head SEO set inside its snapshot, and the visitor resolver reads them from there instead of the live `pages` row. Retitling a page no longer changes the served `<title>` until it is republished. A snapshot published before this change has neither, and serves an empty title and the default SEO set until the page is republished.

- [#13](https://github.com/flovan/plakboek/pull/13) [`0f2e624`](https://github.com/flovan/plakboek/commit/0f2e6241337b58df2ba77fbe5f28e5fe1b0c0791) Thanks [@flovan](https://github.com/flovan)! - `publishPage` now refuses a default-locale page whose public path would lead to a different address (a path starting with an enabled locale code, such as `nl/x` or `en/about`) with the new `PageAddressUnreachableError`, instead of publishing a page nobody can reach. The public-path mapping is split into its own module and `toPublicPagePath`'s documentation no longer claims it inverts the matcher for every address.

- [#13](https://github.com/flovan/plakboek/pull/13) [`1ee5b62`](https://github.com/flovan/plakboek/commit/1ee5b625cc2650070a42036447f0ada2fe449cc7) Thanks [@flovan](https://github.com/flovan)! - A page URL pattern's literal text is now limited to lowercase letters, digits, hyphens and `/`; anything else is reported as an `INVALID_LITERAL` issue by `parsePageUrlPattern`.

- [#13](https://github.com/flovan/plakboek/pull/13) [`8432ec7`](https://github.com/flovan/plakboek/commit/8432ec7cc443af889353e19104bb8e37bfc04738) Thanks [@flovan](https://github.com/flovan)! - Added `resolveVisitorPage` and its path helpers, a published-only, two-statement read that maps a public URL (unprefixed default locale, home slug) to a published page without touching the working block tree.

### Patch Changes

- Updated dependencies [[`e689d61`](https://github.com/flovan/plakboek/commit/e689d614e8dee1bd789b95399487b5af37fa34e5), [`547d989`](https://github.com/flovan/plakboek/commit/547d98926929dbb91b12e8b3c73865a6b98e3694), [`47d17e5`](https://github.com/flovan/plakboek/commit/47d17e565631763e401e9cea754226519e01ca89)]:
  - @plakboek/auth@0.3.0
  - @plakboek/cache@0.2.0
  - @plakboek/content@0.3.1

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
