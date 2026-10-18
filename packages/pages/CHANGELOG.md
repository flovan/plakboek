# @plakboek/pages

## 0.7.0

### Minor Changes

- [#22](https://github.com/flovan/plakboek/pull/22) [`46b1f42`](https://github.com/flovan/plakboek/commit/46b1f421d731aacabd70efba7ffdb31147049b46) Thanks [@flovan](https://github.com/flovan)! - Blocks gain a third kind, `column`. When a registry holds a column kind, a section accepts only columns and a column sits only directly under a section; a block under a column is placement-checked against the column's section, so host sections never declare `column`, and columns never count toward the section nesting cap. A registry without a column kind behaves exactly as before. Block declarations can also set `layout: { fill: true }` and `starterChildren`, validated when the blocks are defined. The new pure `checkPlacement` returns the refusal reason or `null` for a proposed placement, so an editor can draw legal drop targets from the same rule every insert, move and restore enforces.

- [#22](https://github.com/flovan/plakboek/pull/22) [`4826b5e`](https://github.com/flovan/plakboek/commit/4826b5eb5e237c149761499e87465a4f9c88e84d) Thanks [@flovan](https://github.com/flovan)! - Finish the column model in the engine: `applyBlockEdit` gains a `duplicate` operation (a block's whole subtree copied after it under fresh ids, props, layout and schema versions kept), gives an inserted node its definition's starter children and a new section its first column, and refuses with `SectionColumnRequiredError` any batch that would leave a section without a column. `upgradeSectionColumns` and `upgradeAllSectionColumns` bring existing flat page trees into the column shape without losing data (one revision batch, idempotent, serialised per page), and `resolvePublishedPage` wraps flat published snapshots in a synthetic column on read through `normaliseSnapshotColumns`. `readPageLockView` gives an editor the lock state, the holder's display name and last activity, their own lock's expiry and whether they may take the lock over, and nothing else about the holder.

- [#22](https://github.com/flovan/plakboek/pull/22) [`2e24024`](https://github.com/flovan/plakboek/commit/2e24024daf1ed40c2f5fb3be955a69fc7a5fabcb) Thanks [@flovan](https://github.com/flovan)! - Add `applyBlockEdit`, the editor's batch write: insert (with subtrees and client-chosen ids), update, move and delete operations against one page, applied in one transaction with one revision batch, one audit row and one page version bump. Every block id a batch names is checked against the page it was sent for, a batch holding a delete needs `pages:delete`, and a batch never publishes or purges a cache. Ordering a block between siblings now reads the missing neighbour from the stored list, so "after X" lands directly after X.

- [#22](https://github.com/flovan/plakboek/pull/22) [`58d4b90`](https://github.com/flovan/plakboek/commit/58d4b9042f843fd92543cc4775e897774820889d) Thanks [@flovan](https://github.com/flovan)! - Blocks carry a `layout` stored beside their props: a section's column ratio preset and vertical alignment, and a fill flag on blocks that declare `layout: { fill: true }`. Layout is validated on every write against the built-in column presets (`1`, `1:1`, `2:1`, `1:2`, `1:1:1`, `2:1:1`, `1:2:1`, `1:1:2`, `1:1:1:1`), which a host can narrow or extend with the new `columnPresets` config; equal splits are always allowed and stored as no layout. `insertBlock` and `updateBlockProps` accept an optional `layout`, `BlockRecord` and published snapshot blocks expose it, and revisions record it. Working-tree writes now accept a block whose required property is still empty; publishing still refuses it as `invalid-props`. New `findMissingRequiredProps` and `previewBlockValues` answer what a write would accept without writing. Requires `@plakboek/db` with migration `0004_block_layout`.

### Patch Changes

- [#22](https://github.com/flovan/plakboek/pull/22) [`679d143`](https://github.com/flovan/plakboek/commit/679d143b3ae393141721f7641f10a74443024fdf) Thanks [@flovan](https://github.com/flovan)! - A move or insert that names both neighbours in the wrong order (the "previous" sibling at or after the "next" one) is now refused with `InvalidSiblingReferenceError` (`reason: 'inverted'`) before anything is written. Before, it renumbered the whole sibling list and could store a block with the same `sort_order` as a neighbour, so its place depended on the row id. `InvalidSiblingReferenceError` gains an optional fourth constructor argument and a `reason` field.

- [#22](https://github.com/flovan/plakboek/pull/22) [`93226b4`](https://github.com/flovan/plakboek/commit/93226b4b99bfe217130e05efacd94eb3a956e928) Thanks [@flovan](https://github.com/flovan)! - `applyBlockEdit` now refuses a batch that ends with a section whose stored column ratio names a different number of terms than the section has columns (a ratio for two columns on a one-column section), with `BlockLayoutValidationError` for `columns`. It checks the sections the batch created, gave a layout, or whose columns it added, copied, moved or deleted; a batch that changes a section's column count must put it back on the equal split (no ratio) in the same batch, as the editor does.

- [#22](https://github.com/flovan/plakboek/pull/22) [`c352099`](https://github.com/flovan/plakboek/commit/c352099e3b6269c9b4514a2a3a3185a0d0d92736) Thanks [@flovan](https://github.com/flovan)! - Restoring a revision batch that deleted a whole subtree (a section with its columns and blocks) now works: each re-created block is re-parented to the new id of its re-created parent, where before every child past the root was refused with `RestoreParentNotFoundError` and nothing could be restored. A re-created block takes its depth from where it lands. Migration `0005_revision_block_ref` adds `block_revisions.subject_block_id`, the revised block's id kept as plain data after the block row is deleted (`block_id` is nulled by the foreign key), and backfills it for revisions whose block still exists. A batch that deleted a subtree before this migration cannot be restored below its root, as before.

- [#22](https://github.com/flovan/plakboek/pull/22) [`03b865c`](https://github.com/flovan/plakboek/commit/03b865cd39b6ffe49ba10ec25c4a32047e42940e) Thanks [@flovan](https://github.com/flovan)! - Restoring an `update` revision batch now writes the block's stored layout back (column ratio, alignment, fill) instead of only its props, and the restore revision records the layout that was written. A layout key the current configuration no longer accepts, such as a removed ratio preset, is left out rather than failing the restore. `RestoreBlockPreview` gains an optional `layout` field.

- [#22](https://github.com/flovan/plakboek/pull/22) [`c298afe`](https://github.com/flovan/plakboek/commit/c298afed08f9d64f27eca97576a9b3803245ff7f) Thanks [@flovan](https://github.com/flovan)! - A section always keeps a column on every write path, not only in `applyBlockEdit`: `moveBlock` and `deleteBlock` refuse with `SectionColumnRequiredError` when they would take a section's last column away, and so does `restoreRevisionBatch` when a restored move would. `insertBlock` is documented as the single-block writer that adds no starter column (the column upgrade and `applyBlockEdit` do that).

- [#22](https://github.com/flovan/plakboek/pull/22) [`bb3f473`](https://github.com/flovan/plakboek/commit/bb3f473e0547ff1760f524eeb51ca4204d05fd80) Thanks [@flovan](https://github.com/flovan)! - `upgradeSectionColumns` now locks the page's block rows while it reads them, so a property edit committing during the upgrade can no longer leave the recorded revisions describing props the stored rows no longer have.

- [#22](https://github.com/flovan/plakboek/pull/22) [`23bc841`](https://github.com/flovan/plakboek/commit/23bc841143b5bca5816378c183337116a8993bae) Thanks [@flovan](https://github.com/flovan)! - `upgradeSectionColumns` and `upgradeAllSectionColumns` now respect the page edit lock: a page held by someone else's live lock is left untouched, so its version does not move under an open editor, and the batch upgrade skips such pages until the lock is gone. `upgradeSectionColumns` takes an optional `actorUserId` whose own lock does not block it. The editor's page open takes the lock first and upgrades only a page it holds or that nobody holds.

- [#22](https://github.com/flovan/plakboek/pull/22) [`2f2f419`](https://github.com/flovan/plakboek/commit/2f2f419ab381404ab4b7b2a7a7af8e30ac4fd3ed) Thanks [@flovan](https://github.com/flovan)! - `upgradeSectionColumns` and `upgradeAllSectionColumns` are documented as trusted system operations: they take no actor, check no permission and write no audit row (the revision batch they record has no author), so a caller must authorise the call itself and no HTTP route may expose them directly.

- Updated dependencies [[`babfd25`](https://github.com/flovan/plakboek/commit/babfd255ea45c81587fb87d1d3ca92f6b51d07e2), [`c352099`](https://github.com/flovan/plakboek/commit/c352099e3b6269c9b4514a2a3a3185a0d0d92736)]:
  - @plakboek/db@0.7.0
  - @plakboek/auth@0.7.0
  - @plakboek/content@0.7.0
  - @plakboek/cache@0.7.0
  - @plakboek/permissions@0.7.0

## 0.6.0

### Minor Changes

- [#20](https://github.com/flovan/plakboek/pull/20) [`ebb81f2`](https://github.com/flovan/plakboek/commit/ebb81f2682f2e3a097435166dead985050f36636) Thanks [@flovan](https://github.com/flovan)! - New `resolveEditablePage` reads a page's live working tree by public path, for the editor: unpublished changes are included, draft-only and scheduled pages resolve, trashed pages do not, and it shares the visitor resolver's redirect, not-found and invalid-pattern outcomes without reading a publication. The first address segments `cms` and `api` are now reserved: creating, renaming, moving or translating a page so its path starts with one throws `ReservedPageSlugError`, and a generated root slug skips them (`cms-2`). `checkReservedPagePaths` and `reportReservedPagePaths` (hook `onReservedPagePath`) flag pages that already sit on a reserved segment at boot; they are kept, never deleted or renamed. `RESERVED_PAGE_PATH_SEGMENTS` exposes the list. Saving a page URL pattern whose default-locale addresses would start with one of them (`cms/{path}`, `{locale}/api/{path}`) throws `PageUrlPatternError` with the new issue code `RESERVED_PREFIX`, in `setPageUrlPattern` and in the `computeUrlPatternChangeImpact` preview.

### Patch Changes

- Updated dependencies [[`8867be6`](https://github.com/flovan/plakboek/commit/8867be6314a74735ee143c8e5034692510faf67b)]:
  - @plakboek/auth@0.6.0
  - @plakboek/content@0.6.0
  - @plakboek/cache@0.6.0
  - @plakboek/db@0.6.0
  - @plakboek/permissions@0.6.0

## 0.5.1

### Patch Changes

- Updated dependencies []:
  - @plakboek/auth@0.5.1
  - @plakboek/cache@0.5.1
  - @plakboek/content@0.5.1
  - @plakboek/db@0.5.1
  - @plakboek/permissions@0.5.1

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
