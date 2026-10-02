# @plakboek/pages

Headless pages and the block-tree engine for Plakboek CMS installations:
page records, the adjacency-list block tree, block revisions, publish
snapshots, and the block registry a host extends in code. No admin UI ships
here -- overlay editing and the authoring surface are later phases; this
package returns the tree, revision and publication data that UI reads from
and writes through.

## Install

```sh
pnpm add @plakboek/pages
```

## Status

The Phase 4 (Page & Block Tree Engine) surface is complete: the block/field/
widget registry with its per-property installation constraints and
replacement-compatibility checks, the page hierarchy and its project-wide
URL pattern, the block tree with its placement and section rules and both
depth caps, per-block schema versioning with upcast-on-read and compaction,
per-block revisions with restore, publish and draft snapshots, locales and
the audited locale purge, and page+locale edit locking are all implemented,
proven against real Postgres, and exported from the package entry point
below. No admin UI, renderer or route ships here -- overlay editing (Phase
7), structural editing (Phase 8) and visitor rendering (Phase 5) are later
phases and belong to the host once they exist.

## Registering blocks, field types and widgets

A host declares its whole page-engine configuration once at boot, through
one function:

```ts
import {
  definePagesConfig,
  defineBlocks,
  constrainBlock,
} from '@plakboek/pages';
import { coreBlocks } from '@plakboek/pages/blocks'; // illustrative: a host's own core block package

const config = definePagesConfig({
  content: contentConfig, // the @plakboek/content ContentConfig this install already defines
  blocks: defineBlocks([
    ...coreBlocks,
    {
      key: 'testimonial',
      kind: 'block',
      editor: { label: 'Testimonial', category: 'Content' },
      properties: {
        quote: { fieldType: 'long_text', label: 'Quote', required: true },
        author: { fieldType: 'short_text', label: 'Author' },
      },
      schemaVersion: 1,
    },
  ]),
  fieldTypes: [], // host field types, registered through @plakboek/content's own door
  widgets: [], // host widgets for a built-in or host field type
  constraints: [constrainBlock('card', { image: 'hidden' })],
});
```

**Override order.** `blocks`, `fieldTypes` and `widgets` are each walked in
the array order the host composes them in, and a later entry sharing the
same key replaces an earlier one -- position alone decides. There is no
precedence table and no priority field: a host that spreads its own blocks
ahead of `coreBlocks` (rather than after, as above) gets its own versions
silently shadowed instead of shadowing the core ones. A host that forgets
to spread the core blocks into its own array at all loses them entirely --
this is the cost of a rule with no hidden behaviour, and it is deliberate
(EXT-02, ROADMAP criterion 5).

**A block declaration** carries a `key`, a `kind` (`'block'` or
`'section'`), `editor` metadata (label, description, icon, category),
typed `properties`, a `placement` (which owner types, parents and children
it accepts), a `schemaVersion`, an optional `minSupportedVersion`, and its
`upcasters` (one function per version step). A property's `fieldType`
reuses `@plakboek/content`'s field-type registry -- the same options
schema, value schema and widget system content fields use -- so a host
field type registered through `registerHostFieldType` (`@plakboek/content`)
works in a block property with no further wiring.

**Constraining a built-in block:** an installation narrows a block it did
not write, without editing core, by declaring a per-property constraint and
passing it to `definePagesConfig`'s `constraints` array:

```ts
constrainBlock('card', {
  image: 'hidden',
  padding: { fixed: 'lg' },
  variant: { allow: ['primary', 'secondary'] },
});
```

`hidden` removes the property from the editor and refuses it on write;
`fixed` pins it to one value, still validated against the property's own
field type; `allow` narrows a `select`/`multi_select`-shaped property's
choices to a subset. A constraint never touches a value already stored for
that property -- it changes what a _future_ write may set, never what a
past one already holds.

**Replacing a built-in block:** re-register the same `key` later in the
`blocks` array (position decides, per the override rule above), declaring
your own property schema and `schemaVersion`. Every stored instance must
still be reachable: the engine compares the replacement's version lineage
(`schemaVersion`, `minSupportedVersion`, `upcasters`) against every stored
instance's own version at boot, and **fails loudly, naming the block key
and every affected version**, when a replacement cannot bring a stored
instance to its current shape. A version too old for the new
`minSupportedVersion` degrades at read time instead (see below) -- that is
a warning, never a boot failure.

**Sections:** a section is an ordinary block declaration with
`kind: 'section'`. A page's direct children are always sections -- the tree
shape is uniform, so a renderer always has layout context. Sections nest to
a configurable `sectionNestingDepth` (default `2`: a section inside a
section, no third level), and no block of any kind nests past a configurable
`blockDepthCeiling` (default `12`, a coarser runaway-recursion guard). A
section's properties are meant to be layout-only; a boot-time lint flags a
content-ish field type or a content-ish property name on one, naming the
section and the property -- it never throws, since "layout properties only"
has no closed vocabulary, and a section may declare `lintExempt: true` to
opt out of the content findings (the opt-out itself is still reported, so it
stays visible rather than silently suppressing the lint).

**Old stored properties:** a stored block instance whose version cannot
reach the registry's current shape on read is never rewritten or dropped --
it is returned `degraded: true` with a reason (`no-upcaster`,
`upcaster-threw`, `below-floor`, `above-current` or `unknown-block-type`),
reported through the injectable warning hook, and left for the caller to
decide how to present. **A degraded block refuses a publish** (and a draft
snapshot), naming every offending block, before anything is written --
shipping knowingly broken content to visitors is a true integrity break, so
the previously published snapshot keeps serving instead.

## Public API

Every export of `@plakboek/pages`, grouped the way `src/index.ts` groups
them. `tests/unit/public-api.test.ts` compares these tables with the entry
point, so an export cannot be added or removed without updating them.

### Host config

| Export                          | Kind     | Purpose                                                                                                                       |
| ------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `definePagesConfig`             | function | Validates and freezes a host's blocks/field types/widgets/constraints, registering all of them                                |
| `PagesConfigError`              | class    | Thrown by `definePagesConfig` with every problem found                                                                        |
| `reportPagesWarning`            | function | Calls a host-supplied hook so it can never throw or reject into the caller                                                    |
| `DEFAULT_SECTION_NESTING_DEPTH` | constant | `2`: the default section-nesting cap (D-18)                                                                                   |
| `DEFAULT_BLOCK_DEPTH_CEILING`   | constant | `12`: the default coarse block-depth ceiling                                                                                  |
| `LocaleRemovedEvent`            | type     | What `onLocaleRemoved` receives when a removed locale still holds pages                                                       |
| `PagesConfig`                   | type     | The frozen, validated result of `definePagesConfig`                                                                           |
| `PagesConfigInput`              | type     | Input to `definePagesConfig`                                                                                                  |
| `PagesConfigIssue`              | type     | One `definePagesConfig` problem                                                                                               |
| `PagesConfigIssueCode`          | type     | `NO_BLOCKS`, `INVALID_SECTION_NESTING_DEPTH`, `INVALID_BLOCK_DEPTH_CEILING`                                                   |
| `PagesDeps`                     | type     | The dependency bag every engine operation takes: `db`, `recorder`, `resolver`, `config`, optional `hooks`/`invalidator`/`now` |
| `PagesHooks`                    | type     | Optional warning hooks a host passes on `PagesDeps`                                                                           |

### Status and kind catalogues

| Export                 | Kind     | Purpose                                                               |
| ---------------------- | -------- | --------------------------------------------------------------------- |
| `BLOCK_CHANGE_TYPES`   | constant | Frozen `['create', 'update', 'move', 'delete']`                       |
| `BLOCK_REVISION_KINDS` | constant | Frozen `['save', 'publish']`                                          |
| `OWNER_TYPES`          | constant | Frozen `['page']` -- polymorphic column, one legal value today        |
| `PAGE_STATUSES`        | constant | Frozen `['draft', 'published', 'scheduled', 'trashed']`               |
| `BlockChangeType`      | type     | One of `BLOCK_CHANGE_TYPES`                                           |
| `BlockNode`            | type     | A `BlockRecord` plus its resolved children and upcast-on-read outcome |
| `BlockRecord`          | type     | A block as stored, in camelCase                                       |
| `BlockRevisionKind`    | type     | One of `BLOCK_REVISION_KINDS`                                         |
| `OwnerRef`             | type     | The `(ownerType, ownerId, locale)` tuple the tree layer keys on       |
| `OwnerType`            | type     | One of `OWNER_TYPES`                                                  |
| `PageRecord`           | type     | A page as stored, in camelCase                                        |
| `PageStatus`           | type     | One of `PAGE_STATUSES`                                                |

### Block registry

| Export                       | Kind     | Purpose                                                                   |
| ---------------------------- | -------- | ------------------------------------------------------------------------- |
| `BLOCK_KEY_PATTERN`          | constant | Allowed shape of a block's `key`                                          |
| `BLOCK_PROPERTY_KEY_PATTERN` | constant | Allowed shape of a block property's key                                   |
| `BlockConfigError`           | class    | Thrown by `defineBlocks` with every problem found                         |
| `BlockPropsValidationError`  | class    | Thrown when a block instance's props fail validation on write             |
| `defineBlocks`               | function | Validates and registers a host's block declarations, collect-then-throw   |
| `getBlockDefinition`         | function | The registered `BlockDefinition` for a block type, or throws              |
| `listBlockDefinitions`       | function | Every currently registered `BlockDefinition`                              |
| `resolveBlockProperties`     | function | A block's real, currently-applicable properties with constraints resolved |
| `UnknownBlockTypeError`      | class    | A block type string has no registered definition                          |
| `BlockConfigIssue`           | type     | One `defineBlocks` problem                                                |
| `BlockConfigIssueCode`       | type     | One `defineBlocks` problem code                                           |
| `BlockDefinition`            | type     | A block declaration's frozen, normalised form                             |
| `BlockDefinitionInput`       | type     | Input to `defineBlocks`, one entry per block                              |
| `BlockEditorMetadata`        | type     | A block's editor-facing label/description/icon/category                   |
| `BlockKind`                  | type     | `'block'` or `'section'`                                                  |
| `BlockPlacement`             | type     | Where a block may sit: owner types, allowed parents, allowed children     |
| `BlockPropertyDefinition`    | type     | One typed block property                                                  |
| `BlockPropsValidationIssue`  | type     | One `BlockPropsValidationError` problem                                   |
| `BlockUpcaster`              | type     | A function upcasting one version step's props                             |
| `ResolvedBlockPlacement`     | type     | The frozen, defaulted form of `BlockPlacement`                            |
| `ResolvedBlockProperty`      | type     | A property as resolved for the editor/write path, with its constraint     |
| `ResolvedPropertyConstraint` | type     | One property's resolved `hidden`/`fixed`/`narrowed` constraint            |

### Installation constraints (BLOCK-08)

| Export                     | Kind     | Purpose                                                                                                                          |
| -------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `BlockConstraintError`     | class    | Thrown by `definePagesConfig` with every constraint problem found                                                                |
| `constrainBlock`           | function | Composes one block's per-property constraint set                                                                                 |
| `BlockConstraintIssue`     | type     | One constraint-set problem                                                                                                       |
| `BlockConstraintIssueCode` | type     | `UNKNOWN_BLOCK`, `UNKNOWN_PROPERTY`, `INVALID_FIXED_VALUE`, `INVALID_ALLOW_VALUE`, `ALLOW_NOT_SUPPORTED`, `DUPLICATE_CONSTRAINT` |
| `BlockConstraintSet`       | type     | The result of `constrainBlock`, input to `definePagesConfig`                                                                     |
| `PropertyConstraint`       | type     | `'hidden'`, `{ fixed }` or `{ allow }`                                                                                           |

### Replacement compatibility (BLOCK-09)

| Export                     | Kind     | Purpose                                                                      |
| -------------------------- | -------- | ---------------------------------------------------------------------------- |
| `assertBlockCompatibility` | function | The boot gate: throws when a replacement cannot reach every stored instance  |
| `BlockCompatibilityError`  | class    | Thrown by `assertBlockCompatibility` naming every incompatible block/version |
| `checkBlockCompatibility`  | function | Classifies every stored version as compatible/`belowFloor`/`incompatible`    |
| `BelowFloorBlockEntry`     | type     | One block type holding instances below its declared floor                    |
| `BelowFloorEvent`          | type     | What `onBelowFloor` receives for a below-floor block type                    |
| `BlockCompatibilityReport` | type     | The result of `checkBlockCompatibility`                                      |
| `IncompatibleBlockEntry`   | type     | One block type a replacement cannot bring every stored instance to           |

### Section layout lint (BLOCK-05, D-17)

| Export                             | Kind     | Purpose                                                                                  |
| ---------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `lintSectionProperties`            | function | Flags content-ish field types/property names on a section, never throws                  |
| `SECTION_LINT_FIELD_TYPES`         | constant | The four flagged content field types (`rich_text`, `reference`, `repeater`, `long_text`) |
| `SECTION_LINT_PROPERTY_SUBSTRINGS` | constant | The six flagged content-ish property-name substrings                                     |
| `SectionLintEvent`                 | type     | What `onSectionLint` receives: every finding from one lint pass                          |
| `SectionLintFinding`               | type     | One `lintSectionProperties` finding                                                      |
| `SectionLintReason`                | type     | `'content-field-type'`, `'content-property-name'` or `'exempt'`                          |

### Placement refusals (BLOCK-05, D-08, D-18, D-19)

| Export                             | Kind     | Purpose                                                                 |
| ---------------------------------- | -------- | ----------------------------------------------------------------------- |
| `BlockDepthExceededError`          | class    | A write would exceed `blockDepthCeiling`                                |
| `BlockPlacementError`              | class    | An owner-type/parent/child placement rule refused a write               |
| `ROOT_PARENT_SENTINEL`             | constant | The `allowedParents`/`allowedChildren` key naming "the page's own root" |
| `SectionNestingDepthExceededError` | class    | A write would exceed `sectionNestingDepth`                              |
| `SectionRequiredError`             | class    | A non-section block was inserted with no parent directly under a page   |
| `BlockPlacementReason`             | type     | `'owner-type'`, `'parent-rejects-child'` or `'child-rejects-parent'`    |

### Schema versioning and upcast-on-read (BLOCK-12, D-10..D-15)

| Export                | Kind     | Purpose                                                                          |
| --------------------- | -------- | -------------------------------------------------------------------------------- |
| `createUpcastSession` | function | A per-tree-read cache of resolved upcaster chains, for `readBlockTree`'s own use |
| `DEGRADED_REASONS`    | constant | Every reason a stored instance can fail to reach the current shape on read       |
| `upcastOnRead`        | function | Upcasts one row's props from a stored version to the current schema, in memory   |
| `DegradedBlockEvent`  | type     | What `onDegradedBlock` receives for one degraded row a tree read produces        |
| `DegradedReason`      | type     | One of `DEGRADED_REASONS`                                                        |
| `UpcastOutcome`       | type     | The result of `upcastOnRead`                                                     |
| `UpcastSession`       | type     | The result of `createUpcastSession`                                              |

### Compaction and the below-floor report (D-13, D-14, D-15)

| Export                    | Kind     | Purpose                                                                           |
| ------------------------- | -------- | --------------------------------------------------------------------------------- |
| `compactBlockType`        | function | Force-upcasts and writes back every upgradable instance of one block type         |
| `computeCompactionImpact` | function | Previews what `compactBlockType` would rewrite or skip, without writing           |
| `reportBelowFloorBlocks`  | function | The D-14 boot report: warns once per block type holding instances below its floor |
| `CompactBlockTypeInput`   | type     | Input to `compactBlockType`                                                       |
| `CompactionImpact`        | type     | The result of `computeCompactionImpact`                                           |
| `CompactionImpactEntry`   | type     | One stored version's upcastability within a `CompactionImpact`                    |
| `CompactionResult`        | type     | The result of `compactBlockType`                                                  |
| `CompactionSkippedEntry`  | type     | One instance `compactBlockType` could not rewrite, and why                        |

### Sibling ordering

| Export             | Kind     | Purpose                                                                 |
| ------------------ | -------- | ----------------------------------------------------------------------- |
| `needsRebalance`   | function | Whether two neighbouring `sort_order`s have closed the gap between them |
| `nextSortOrder`    | function | The `sort_order` for a new last sibling, given the current maximum      |
| `rebalancedOrders` | function | Fresh, evenly-spaced `sort_order` values for a rebalanced sibling list  |
| `SORT_ORDER_STEP`  | constant | `1000`: the sparse-integer step every sibling order is derived from     |
| `sortOrderBetween` | function | The `sort_order` for a block placed between two siblings' own orders    |

### Page slugs

| Export                     | Kind     | Purpose                                                                     |
| -------------------------- | -------- | --------------------------------------------------------------------------- |
| `InvalidPageSlugError`     | class    | A title or hand-typed slug normalises to empty, or isn't already normalised |
| `PAGE_SLUG_LOCK_NAMESPACE` | constant | The advisory-lock namespace page slug generation serialises under           |
| `PageSlugConflictError`    | class    | A hand-typed slug's composed path is already used by another page           |

### Page URL patterns (D-22)

A pattern's literal text may contain only lowercase letters, digits, hyphens and `/` (anything else is an `INVALID_LITERAL` issue), so every public page URL is lowercase and free of percent-encoding, which lets the visitor handler reject junk paths before any database access without ever losing a real page.

| Export                        | Kind     | Purpose                                                       |
| ----------------------------- | -------- | ------------------------------------------------------------- |
| `DEFAULT_PAGE_URL_PATTERN`    | constant | `'{locale}/{path}'`: the seeded project-wide pattern          |
| `PAGE_URL_PATTERN_MAX_LENGTH` | constant | `200`: maximum length of a page URL pattern string            |
| `PAGE_URL_PATTERN_TOKENS`     | constant | `locale` and `path` -- the only tokens a page pattern may use |
| `PageUrlPatternError`         | class    | Thrown by `parsePageUrlPattern` with every malformation found |
| `parsePageUrlPattern`         | function | Parses a page URL pattern string, collecting every issue      |
| `resolvePageUrlPath`          | function | Resolves a parsed pattern against one page's locale/path      |
| `ParsedPageUrlPattern`        | type     | The result of `parsePageUrlPattern`                           |
| `PageUrlPatternIssue`         | type     | One `parsePageUrlPattern` problem                             |
| `PageUrlPatternIssueCode`     | type     | One `parsePageUrlPattern` problem code                        |
| `PageUrlPatternToken`         | type     | One of `PAGE_URL_PATTERN_TOKENS`                              |
| `ResolvePageUrlPathInput`     | type     | Input to `resolvePageUrlPath`                                 |

### Page engine settings (D-40)

| Export                           | Kind     | Purpose                                                                |
| -------------------------------- | -------- | ---------------------------------------------------------------------- |
| `getPageEditLocking`             | function | Reads the project-wide page edit-lock toggle                           |
| `getPageEngineSettings`          | function | Reads the single project-wide page engine settings row                 |
| `getPageUrlPattern`              | function | Reads just the stored page URL pattern                                 |
| `PageEngineSettingsMissingError` | class    | The seeded settings row is absent -- did the migration seed run?       |
| `setPageEditLocking`             | function | Sets the project-wide page edit-lock toggle, audited                   |
| `PageEngineSettings`             | type     | The settings row's shape: `pageEditLocking`, `urlPattern`, `updatedAt` |
| `SetPageEditLockingInput`        | type     | Input to `setPageEditLocking`                                          |
| `SetPageEditLockingResult`       | type     | The result of `setPageEditLocking`: `{ previous, current }`            |

### Publish-time addresses and the URL pattern change (D-22)

| Export                               | Kind     | Purpose                                                                               |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------- |
| `computePageResolvedPath`            | function | Computes a page's resolved address from the pattern and its own locale/path           |
| `computeUrlPatternChangeImpact`      | function | Previews what changing the project-wide pattern would move or collide                 |
| `PageUrlCollisionError`              | class    | A page's resolved address is already held by another page in the same locale          |
| `PageUrlPatternCollisionError`       | class    | A pattern change would give two published pages the same resolved address             |
| `setPageUrlPattern`                  | function | Changes the project-wide page URL pattern, recomputing every published page's address |
| `ComputePageResolvedPathInput`       | type     | Input to `computePageResolvedPath`                                                    |
| `ComputeUrlPatternChangeImpactInput` | type     | Input to `computeUrlPatternChangeImpact`                                              |
| `PageUrlPatternChangeImpact`         | type     | The result of `computeUrlPatternChangeImpact`                                         |
| `PageUrlPatternCollision`            | type     | One resolved address a pattern change would give to more than one page                |
| `SetPageUrlPatternInput`             | type     | Input to `setPageUrlPattern`                                                          |

### Pages (hierarchy, creation, rename, move)

| Export                  | Kind     | Purpose                                                                            |
| ----------------------- | -------- | ---------------------------------------------------------------------------------- |
| `CircularPageMoveError` | class    | `movePage` given a destination that is the page itself or its own descendant       |
| `createPage`            | function | Creates a draft page, resolving its slug and path                                  |
| `getPage`               | function | Reads one page by id, or `null`                                                    |
| `getPageByPath`         | function | Reads one page by its locale-scoped hierarchical path                              |
| `listChildPages`        | function | Lists a page's direct children (or root pages)                                     |
| `LocaleMismatchError`   | class    | `movePage` given a destination parent in a different locale                        |
| `LocaleNotEnabledError` | class    | An operation given a locale not in `PagesConfig.content.locales`                   |
| `movePage`              | function | Moves a page and its whole subtree to a new parent (or the root)                   |
| `PageNotFoundError`     | class    | A page id does not exist                                                           |
| `PagePathConflictError` | class    | A page's computed path is already used by another page in the same locale          |
| `renamePage`            | function | Renames a page's title and/or slug, rewriting its subtree's paths on a slug change |
| `StalePageVersionError` | class    | A structural write's `baseVersion` no longer matches the page's stored version     |
| `CreatePageInput`       | type     | Input to `createPage`                                                              |
| `GetPageByPathInput`    | type     | Input to `getPageByPath`                                                           |
| `ListChildPagesInput`   | type     | Input to `listChildPages`                                                          |
| `MovePageInput`         | type     | Input to `movePage`                                                                |
| `RenamePageInput`       | type     | Input to `renamePage`                                                              |

### Page translation groups (D-21, D-36)

| Export                       | Kind     | Purpose                                                      |
| ---------------------------- | -------- | ------------------------------------------------------------ |
| `createPageTranslation`      | function | Adds an enabled locale to an existing page translation group |
| `listPageTranslations`       | function | Reads every enabled-locale row of a translation group        |
| `PageTranslationExistsError` | class    | The group already has a page for the requested locale        |
| `CreatePageTranslationInput` | type     | Input to `createPageTranslation`                             |
| `ListPageTranslationsInput`  | type     | Input to `listPageTranslations`                              |

### Block tree (reads and structural writes, D-38)

| Export                         | Kind     | Purpose                                                                                             |
| ------------------------------ | -------- | --------------------------------------------------------------------------------------------------- |
| `BlockNotFoundError`           | class    | A block write names a block/parent id that no longer exists                                         |
| `CircularMoveError`            | class    | `moveBlock` given a destination that is the block itself or its own descendant                      |
| `computeBlockDeleteImpact`     | function | Previews what deleting a block (and its subtree) would touch                                        |
| `deleteBlock`                  | function | Deletes a block and its whole subtree, keeping its revision history                                 |
| `insertBlock`                  | function | Inserts a block, enforcing placement, section and depth rules on write                              |
| `InvalidSiblingReferenceError` | class    | `moveBlock` given a `beforeSiblingId`/`afterSiblingId` that isn't a child of the destination parent |
| `moveBlock`                    | function | Moves a block and its whole subtree to a new parent and sibling position                            |
| `readBlockTree`                | function | Reads one owner's full block tree, upcasting each row's props on the way out                        |
| `StaleBlockVersionError`       | class    | A block write's `baseVersion` no longer matches the block's stored version                          |
| `updateBlockProps`             | function | Edits a block's properties, validated against its current declaration                               |
| `BlockDeleteImpact`            | type     | The result of `computeBlockDeleteImpact`/`deleteBlock`                                              |
| `DeleteBlockInput`             | type     | Input to `deleteBlock`                                                                              |
| `InsertBlockInput`             | type     | Input to `insertBlock`                                                                              |
| `MoveBlockInput`               | type     | Input to `moveBlock`                                                                                |
| `UpdateBlockPropsInput`        | type     | Input to `updateBlockProps`                                                                         |

### Block revisions and restore (D-26..D-29, D-13)

| Export                            | Kind     | Purpose                                                                       |
| --------------------------------- | -------- | ----------------------------------------------------------------------------- |
| `computeBlockRestorePreview`      | function | Previews restoring a revision batch onto the current schema, without writing  |
| `DegradedRestoreError`            | class    | A restore would recreate a block that cannot reach the current schema cleanly |
| `listBatchRevisions`              | function | Expands one revision batch into its block revisions                           |
| `listPageRevisionBatches`         | function | Rolls a page's block revisions up to one row per save/publish batch           |
| `restoreRevisionBatch`            | function | Restores a revision batch as one audited, version-checked, validated mutation |
| `RestoreParentNotFoundError`      | class    | A restored revision's recorded parent block no longer exists                  |
| `RestoreTargetNotFoundError`      | class    | A restored revision's block no longer exists to restore onto                  |
| `RevisionBatchNotFoundError`      | class    | A revision batch id names no rows                                             |
| `BlockRevisionSummary`            | type     | One entry in `listBatchRevisions`' result                                     |
| `ComputeBlockRestorePreviewInput` | type     | Input to `computeBlockRestorePreview`                                         |
| `ListPageRevisionBatchesInput`    | type     | Input to `listPageRevisionBatches`                                            |
| `RestoreBatchPreview`             | type     | The result of `computeBlockRestorePreview`                                    |
| `RestoreBatchResult`              | type     | The result of `restoreRevisionBatch`                                          |
| `RestoreBlockPreview`             | type     | One block's classification within a `RestoreBatchPreview`                     |
| `RestorePropertyOutcome`          | type     | One property's `mapped`/`defaulted`/`dropped`/`failed` classification         |
| `RestoreRevisionBatchInput`       | type     | Input to `restoreRevisionBatch`                                               |
| `RevisionBatchSummary`            | type     | One entry in `listPageRevisionBatches`' result                                |

**Known limitation:** `restoreRevisionBatch` recreates a single deleted
block correctly under a fresh id. Restoring a whole subtree deleted
together in one batch (several blocks recreated at once, a descendant
whose recorded `parent_block_id` names a sibling also being recreated in
the same call) does not remap that linkage onto the siblings' newly
assigned ids -- it fails loudly with a foreign-key violation rather than
silently reparenting onto the wrong block. A single deleted block restores
correctly today; multi-block subtree-delete restore is deferred to
whichever later phase builds the history/restore UI.

### Publish and draft snapshots (D-30..D-33)

When `PagesDeps.invalidator` is set, `publishPage` purges the page's cache tag
after its transaction commits; a refused publish purges nothing and a failing
purge never fails the committed publish.

A publication freezes the page's `title` and head SEO set next to its block
tree, so retitling a page or editing its SEO reaches visitors only through the
next publish, exactly like a block edit. A snapshot published before these were
frozen carries neither: it serves an empty title and the default SEO set
(indexable, no overrides) until the page is republished, and the visitor path
never falls back to the live `pages` row for them.

| Export                      | Kind     | Purpose                                                                                        |
| --------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `createDraftSnapshot`       | function | Builds a draft snapshot from a page's current tree, identical to what publishing would produce |
| `DegradedBlockPublishError` | class    | A publish or draft was refused because one or more blocks are degraded                         |
| `publishPage`               | function | Publishes a page: validates, snapshots, records revisions, materialises the address            |
| `readLatestDraftSnapshot`   | function | Reads the newest draft snapshot for a page, or `null`                                          |
| `readPublishedSnapshot`     | function | Reads the snapshot a page's live publication points at -- the visitor-path read                |
| `CreateDraftSnapshotInput`  | type     | Input to `createDraftSnapshot`                                                                 |
| `DegradedSnapshotBlock`     | type     | One block that stopped a publish or draft from being built                                     |
| `PagePublicationRecord`     | type     | A stored publication row: snapshot, revision manifest, hash, `isDraft`                         |
| `PageSnapshot`              | type     | The materialised snapshot: block tree plus the frozen title and head SEO set                   |
| `PublishPageInput`          | type     | Input to `publishPage`                                                                         |
| `SnapshotBlock`             | type     | One block in the materialised snapshot tree                                                    |

### Cache invalidation (D-18, D-19)

Every write that changes what a visitor can see purges the affected cache tags
after its transaction commits, through `PagesDeps.invalidator`. A refused,
denied or rolled-back write purges nothing, and a failing purge never fails the
write: the failure reaches the recorder's `onAfterCommitFailed` hook instead.

| Write path                                                                           | Purges                                         |
| ------------------------------------------------------------------------------------ | ---------------------------------------------- |
| publish                                                                              | `page:<id>`                                    |
| unpublish                                                                            | `page:<id>`                                    |
| trash, permanent delete                                                              | `page:<id>` of every page in the subtree       |
| restore                                                                              | `page:<id>` of every restored page             |
| move, rename with a new slug                                                         | `page:<id>` of every page in the subtree       |
| rename with only a new title                                                         | `page:<id>` of the renamed page                |
| URL-pattern change (only when the stored value changes)                              | `global`                                       |
| locale purge                                                                         | `global`                                       |
| schedule, unschedule                                                                 | none (the Phase 13 job calls `purgePageTags`)  |
| block writes, revision restore, compaction, locks, create, translate, draft snapshot | none (live side only, never visitor-reachable) |

A moved or renamed published page is unaddressed until it is republished: its
old and new URLs both answer 404, and each descendant stays unaddressed until
it is republished too (redirects over `page_url_history` arrive in Phase 16).

### Page status transitions (D-20)

| Export                             | Kind     | Purpose                                                                       |
| ---------------------------------- | -------- | ----------------------------------------------------------------------------- |
| `AncestorTrashedError`             | class    | `restorePageFromTrash` refused -- an ancestor is still trashed                |
| `computePagePermanentDeleteImpact` | function | Previews what permanently deleting a page (and its subtree) would remove      |
| `computePageTrashImpact`           | function | Previews what trashing a page (and its subtree) would touch                   |
| `deletePagePermanently`            | function | Permanently deletes a page and its whole subtree, including its revisions     |
| `PageScheduleNotInFutureError`     | class    | `schedulePage` given an instant at or before now                              |
| `PageStatusError`                  | class    | A lifecycle operation given a page in the wrong status                        |
| `restorePageFromTrash`             | function | Restores a trashed page (and what that same trash operation trashed) to draft |
| `schedulePage`                     | function | Sets a future `scheduledAt` on a draft page, never publishes                  |
| `trashPage`                        | function | Trashes a page and its whole subtree                                          |
| `unpublishPage`                    | function | Returns a published page to draft, clearing its resolved address              |
| `unschedulePage`                   | function | Clears a pending schedule, returning to draft                                 |
| `DeletePagePermanentlyInput`       | type     | Input to `deletePagePermanently`                                              |
| `PagePermanentDeleteImpact`        | type     | The result of `computePagePermanentDeleteImpact`                              |
| `PageTrashImpact`                  | type     | The result of `computePageTrashImpact`                                        |
| `SchedulePageInput`                | type     | Input to `schedulePage`                                                       |
| `TrashPageInput`                   | type     | Input to `trashPage`                                                          |
| `UnpublishPageInput`               | type     | Input to `unpublishPage`                                                      |
| `UnschedulePageInput`              | type     | Input to `unschedulePage`                                                     |

### Locales (D-37)

| Export                          | Kind     | Purpose                                                                            |
| ------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `checkPageLocales`              | function | Reports a removed locale's stored counts across every page-engine table, read-only |
| `computeLocalePurgeImpact`      | function | Reports what purging a locale would delete across both engines, read-only          |
| `LocaleStillEnabledError`       | class    | `purgeLocale` refused -- the locale is still enabled in `PagesConfig`              |
| `purgeLocale`                   | function | Deletes every page-engine and content-engine row for a locale, in one transaction  |
| `reportPageLocaleRemoval`       | function | Fires the boot-time warning hook once per `checkPageLocales` result row            |
| `ComputeLocalePurgeImpactInput` | type     | Input to `computeLocalePurgeImpact`                                                |
| `LocalePurgeReport`             | type     | The result of `computeLocalePurgeImpact`/`purgeLocale`: page-engine + entry counts |
| `PageLocaleCounts`              | type     | One locale's stored counts across the page-engine tables                           |
| `PurgeLocaleInput`              | type     | Input to `purgeLocale`                                                             |

### Page+locale edit locking (D-39..D-41, D-44)

| Export                             | Kind     | Purpose                                                              |
| ---------------------------------- | -------- | -------------------------------------------------------------------- |
| `acquirePageLock`                  | function | Acquires the lock on one page locale row -- the open call            |
| `isPageLockLive`                   | function | Whether a lock is still live, given its holder, `lockedAt` and now   |
| `PAGE_EDIT_LOCK_HEARTBEAT_SECONDS` | constant | `30`: how often a holder should renew                                |
| `PAGE_EDIT_LOCK_TTL_SECONDS`       | constant | `120`: how long a lock stays live with no renewal                    |
| `PageLockedError`                  | class    | A write, acquire or renew refused by another user's live lock        |
| `PageLockingDisabledError`         | class    | `acquirePageLock` called while the project-wide toggle is off        |
| `PageLockNotFoundError`            | class    | A lock operation names a page id that no longer exists               |
| `PageLockStateChangedError`        | class    | A takeover's decision went stale between the pre-check and the write |
| `PageLockTakeoverForbiddenError`   | class    | The caller's permissions are not a superset of the current holder's  |
| `releasePageLock`                  | function | Releases the lock on one page locale row -- the navigate-away call   |
| `renewPageLock`                    | function | Renews the current holder's lock -- the heartbeat call               |
| `takeOverPageLock`                 | function | Takes over another user's live lock; needs a permission superset     |
| `AcquirePageLockInput`             | type     | Input to `acquirePageLock`                                           |
| `PageLockGrant`                    | type     | The result of `acquirePageLock`                                      |
| `PageLockState`                    | type     | The lock's shape on a page row -- what `takeOverPageLock` returns    |
| `ReleasePageLockInput`             | type     | Input to `releasePageLock`                                           |
| `RenewPageLockInput`               | type     | Input to `renewPageLock`                                             |
| `TakeOverPageLockInput`            | type     | Input to `takeOverPageLock`                                          |

**Deliberately lock-exempt.** `compactBlockType` (schema compaction),
`setPageUrlPattern` (the project-wide URL pattern change) and `purgeLocale`
(the locale purge) never call the write guard above -- each is a project-wide
administrative bulk operation, not a single page's edit, and a per-page edit
lock blocking one would be impractical. Each is gated by its own permission
(`pages:edit`, `pages:publish`, and the dual `pages:delete-permanent` +
`entries:delete-permanent` check respectively) and recorded through
`deps.recorder.run` instead.

### Visitor resolution (D-20..D-26)

| Export                      | Kind     | Purpose                                                                                    |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `DEFAULT_HOME_SLUG`         | constant | The hierarchy path (`home`) of the page served at a locale's root                          |
| `matchPublicPagePath`       | function | Maps a public URL path to a stored `(locale, path, resolvedPath)`, a redirect, or `none`   |
| `resolvePublishedPage`      | function | One joined read of the published, non-draft page at `(locale, resolvedPath)`, or `null`    |
| `resolveVisitorPage`        | function | The composite the render handler calls: pattern read, path mapping, published read         |
| `toPublicPagePath`          | function | The public URL path of a stored `(locale, path)` address -- the inverse of the matcher     |
| `MatchPublicPagePathInput`  | type     | Input to `matchPublicPagePath`                                                             |
| `PublicPagePathMatch`       | type     | The matcher's result: `match`, `redirect` or `none`                                        |
| `PublishedPageSeo`          | type     | The head-relevant subset of a page's SEO set, as frozen into its publication               |
| `PublishedPageView`         | type     | The narrow published view: page id, locale, title, address, SEO, plus the live publication |
| `ResolvePublishedPageInput` | type     | Input to `resolvePublishedPage`                                                            |
| `ResolveVisitorPageInput`   | type     | Input to `resolveVisitorPage`                                                              |
| `ToPublicPagePathInput`     | type     | Input to `toPublicPagePath`                                                                |
| `VisitorPageResolution`     | type     | The composite's result: `page`, `redirect` or `not-found`                                  |

`resolved_path` is read exactly as it is stored (`en/about-us` under the
default pattern) and is the only working-side value the resolver reads; the
view's title and SEO come out of the published snapshot. Only the resolver maps
that stored form to the public path, so there is no migration. The default locale is served without a locale prefix
(`/about-us` is English, `/nl/over-ons` is Dutch) and its prefixed spelling
(`/en/about-us`) resolves to a redirect whose target is the bare form, which a
render handler answers with a 308. A locale root (`/`, `/nl`) is the published
page whose hierarchy path is the home slug, and the explicit `/home` spelling
redirects to the root. The locale prefix wins over a default-locale page whose
first segment equals an enabled locale code, so an English page with slug `nl`
is unreachable at `/nl/...`. Under a pattern without `{locale}` only the
default locale is addressable. Only the enabled locales passed in are
candidates, so a removed locale (its rows are kept) can never be reached by
URL. A resolution reads at most two statements -- the URL pattern, then the
joined select -- and a redirect or an unshaped path stops after the first.
Draft, scheduled, trashed and unpublished pages and draft snapshots never
resolve, and the view never carries the revision manifest, the publisher, the
working block tree or any lock or version column. Only pages resolve; entry
URLs and the previous-address history are not consulted.

Nothing else is reachable from the entry point. In particular the block-
revision writer and its cap-pruning sweep, the row-locking page read and the
append-only URL-history writer, the write-time placement/depth/section
guards and the ancestor walk behind them, transaction-scoped slug
generation and availability and the address-availability check, the
edit-lock write guard every single-page mutation calls internally (see the
lock-exempt bulk operations above), the shared
publication materialiser, the props validator and the constraint applier,
and every Drizzle schema table stay internal -- with them a consumer could
write or read pages/blocks around the audited, version-checked,
locale-filtered paths this package guarantees. See `src/index.ts`'s own
header comment for the complete, itemised list.
