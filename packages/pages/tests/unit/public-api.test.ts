/**
 * The `@plakboek/pages` entry point is a contract. This suite holds that
 * contract as a literal list and fails when any of three things drifts from
 * it: what `src/index.ts` actually exports, what the README's "Public API"
 * tables document, and what stays unreachable -- the transaction-level
 * writers, the row-locking reads, the write-time guards, the props
 * validator/constraint applier and every Drizzle schema table.
 *
 * Adding an export means adding it here, to the barrel and to the README in
 * the same change. Reproduces `@plakboek/content`'s
 * `tests/unit/public-api.test.ts` technique exactly: reads `src/index.ts`
 * and `README.md` from disk rather than importing the built package, so this
 * suite runs before a build.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const INDEX_PATH = fileURLToPath(
  new URL('../../src/index.ts', import.meta.url),
);
const README_PATH = fileURLToPath(new URL('../../README.md', import.meta.url));

type ValueKind = 'function' | 'class' | 'constant';

/** Every value the entry point exports, grouped as the barrel groups them. */
const PUBLIC_VALUES: Readonly<Record<string, ValueKind>> = Object.freeze({
  // config
  DEFAULT_BLOCK_DEPTH_CEILING: 'constant',
  DEFAULT_SECTION_NESTING_DEPTH: 'constant',
  definePagesConfig: 'function',
  PagesConfigError: 'class',
  reportPagesWarning: 'function',
  // types
  BLOCK_CHANGE_TYPES: 'constant',
  BLOCK_REVISION_KINDS: 'constant',
  OWNER_TYPES: 'constant',
  PAGE_STATUSES: 'constant',
  // registry
  BLOCK_KEY_PATTERN: 'constant',
  BLOCK_PROPERTY_KEY_PATTERN: 'constant',
  BlockConfigError: 'class',
  BlockPropsValidationError: 'class',
  defineBlocks: 'function',
  getBlockDefinition: 'function',
  listBlockDefinitions: 'function',
  resolveBlockProperties: 'function',
  UnknownBlockTypeError: 'class',
  // constraints
  BlockConstraintError: 'class',
  constrainBlock: 'function',
  // compatibility
  assertBlockCompatibility: 'function',
  BlockCompatibilityError: 'class',
  checkBlockCompatibility: 'function',
  // section-lint
  lintSectionProperties: 'function',
  SECTION_LINT_FIELD_TYPES: 'constant',
  SECTION_LINT_PROPERTY_SUBSTRINGS: 'constant',
  // placement
  BlockDepthExceededError: 'class',
  BlockPlacementError: 'class',
  ROOT_PARENT_SENTINEL: 'constant',
  SectionNestingDepthExceededError: 'class',
  SectionRequiredError: 'class',
  // versioning
  createUpcastSession: 'function',
  DEGRADED_REASONS: 'constant',
  upcastOnRead: 'function',
  // compaction
  compactBlockType: 'function',
  computeCompactionImpact: 'function',
  reportBelowFloorBlocks: 'function',
  // ordering
  needsRebalance: 'function',
  nextSortOrder: 'function',
  rebalancedOrders: 'function',
  SORT_ORDER_STEP: 'constant',
  sortOrderBetween: 'function',
  // page-slug
  InvalidPageSlugError: 'class',
  PAGE_SLUG_LOCK_NAMESPACE: 'constant',
  PageSlugConflictError: 'class',
  // page-url-pattern
  DEFAULT_PAGE_URL_PATTERN: 'constant',
  PAGE_URL_PATTERN_MAX_LENGTH: 'constant',
  PAGE_URL_PATTERN_TOKENS: 'constant',
  PageUrlPatternError: 'class',
  parsePageUrlPattern: 'function',
  resolvePageUrlPath: 'function',
  // settings
  getPageEditLocking: 'function',
  getPageEngineSettings: 'function',
  getPageUrlPattern: 'function',
  PageEngineSettingsMissingError: 'class',
  setPageEditLocking: 'function',
  // page-routing
  computePageResolvedPath: 'function',
  computeUrlPatternChangeImpact: 'function',
  PageUrlCollisionError: 'class',
  PageUrlPatternCollisionError: 'class',
  setPageUrlPattern: 'function',
  // pages
  CircularPageMoveError: 'class',
  createPage: 'function',
  getPage: 'function',
  getPageByPath: 'function',
  listChildPages: 'function',
  LocaleMismatchError: 'class',
  LocaleNotEnabledError: 'class',
  movePage: 'function',
  PageNotFoundError: 'class',
  PagePathConflictError: 'class',
  renamePage: 'function',
  StalePageVersionError: 'class',
  // translations
  createPageTranslation: 'function',
  listPageTranslations: 'function',
  PageTranslationExistsError: 'class',
  // tree
  BlockNotFoundError: 'class',
  CircularMoveError: 'class',
  computeBlockDeleteImpact: 'function',
  deleteBlock: 'function',
  insertBlock: 'function',
  moveBlock: 'function',
  readBlockTree: 'function',
  StaleBlockVersionError: 'class',
  updateBlockProps: 'function',
  // revisions
  computeBlockRestorePreview: 'function',
  DegradedRestoreError: 'class',
  listBatchRevisions: 'function',
  listPageRevisionBatches: 'function',
  restoreRevisionBatch: 'function',
  RestoreTargetNotFoundError: 'class',
  RevisionBatchNotFoundError: 'class',
  // publish
  createDraftSnapshot: 'function',
  DegradedBlockPublishError: 'class',
  publishPage: 'function',
  readLatestDraftSnapshot: 'function',
  readPublishedSnapshot: 'function',
  // lifecycle
  AncestorTrashedError: 'class',
  computePagePermanentDeleteImpact: 'function',
  computePageTrashImpact: 'function',
  deletePagePermanently: 'function',
  PageScheduleNotInFutureError: 'class',
  PageStatusError: 'class',
  restorePageFromTrash: 'function',
  schedulePage: 'function',
  trashPage: 'function',
  unpublishPage: 'function',
  unschedulePage: 'function',
  // locale
  checkPageLocales: 'function',
  computeLocalePurgeImpact: 'function',
  LocaleStillEnabledError: 'class',
  purgeLocale: 'function',
  reportPageLocaleRemoval: 'function',
  // locks
  acquirePageLock: 'function',
  isPageLockLive: 'function',
  PAGE_EDIT_LOCK_HEARTBEAT_SECONDS: 'constant',
  PAGE_EDIT_LOCK_TTL_SECONDS: 'constant',
  PageLockedError: 'class',
  PageLockingDisabledError: 'class',
  PageLockNotFoundError: 'class',
  PageLockStateChangedError: 'class',
  PageLockTakeoverForbiddenError: 'class',
  releasePageLock: 'function',
  renewPageLock: 'function',
  takeOverPageLock: 'function',
});

/** Every type the entry point exports. Types leave no runtime trace, so this
 * list is compared with the barrel's source and with the README. */
const PUBLIC_TYPES: readonly string[] = Object.freeze([
  // config
  'LocaleRemovedEvent',
  'PagesConfig',
  'PagesConfigInput',
  'PagesConfigIssue',
  'PagesConfigIssueCode',
  'PagesDeps',
  'PagesHooks',
  // types
  'BlockChangeType',
  'BlockNode',
  'BlockRecord',
  'BlockRevisionKind',
  'OwnerRef',
  'OwnerType',
  'PageRecord',
  'PageStatus',
  // registry
  'BlockConfigIssue',
  'BlockConfigIssueCode',
  'BlockDefinition',
  'BlockDefinitionInput',
  'BlockEditorMetadata',
  'BlockKind',
  'BlockPlacement',
  'BlockPropertyDefinition',
  'BlockPropsValidationIssue',
  'BlockUpcaster',
  'ResolvedBlockPlacement',
  'ResolvedBlockProperty',
  'ResolvedPropertyConstraint',
  // constraints
  'BlockConstraintIssue',
  'BlockConstraintIssueCode',
  'BlockConstraintSet',
  'PropertyConstraint',
  // compatibility
  'BelowFloorBlockEntry',
  'BelowFloorEvent',
  'BlockCompatibilityReport',
  'IncompatibleBlockEntry',
  // section-lint
  'SectionLintEvent',
  'SectionLintFinding',
  'SectionLintReason',
  // placement
  'BlockPlacementReason',
  // versioning
  'DegradedBlockEvent',
  'DegradedReason',
  'UpcastOutcome',
  'UpcastSession',
  // compaction
  'CompactBlockTypeInput',
  'CompactionImpact',
  'CompactionImpactEntry',
  'CompactionResult',
  'CompactionSkippedEntry',
  // page-url-pattern
  'ParsedPageUrlPattern',
  'PageUrlPatternIssue',
  'PageUrlPatternIssueCode',
  'PageUrlPatternToken',
  'ResolvePageUrlPathInput',
  // settings
  'PageEngineSettings',
  'SetPageEditLockingInput',
  'SetPageEditLockingResult',
  // page-routing
  'ComputePageResolvedPathInput',
  'ComputeUrlPatternChangeImpactInput',
  'PageUrlPatternChangeImpact',
  'PageUrlPatternCollision',
  'SetPageUrlPatternInput',
  // pages
  'CreatePageInput',
  'GetPageByPathInput',
  'ListChildPagesInput',
  'MovePageInput',
  'RenamePageInput',
  // translations
  'CreatePageTranslationInput',
  'ListPageTranslationsInput',
  // tree
  'BlockDeleteImpact',
  'DeleteBlockInput',
  'InsertBlockInput',
  'MoveBlockInput',
  'UpdateBlockPropsInput',
  // revisions
  'BlockRevisionSummary',
  'ComputeBlockRestorePreviewInput',
  'ListPageRevisionBatchesInput',
  'RestoreBatchPreview',
  'RestoreBatchResult',
  'RestoreBlockPreview',
  'RestorePropertyOutcome',
  'RestoreRevisionBatchInput',
  'RevisionBatchSummary',
  // publish
  'CreateDraftSnapshotInput',
  'DegradedSnapshotBlock',
  'PagePublicationRecord',
  'PageSnapshot',
  'PublishPageInput',
  'SnapshotBlock',
  // lifecycle
  'DeletePagePermanentlyInput',
  'PagePermanentDeleteImpact',
  'PageTrashImpact',
  'SchedulePageInput',
  'TrashPageInput',
  'UnpublishPageInput',
  'UnschedulePageInput',
  // locale
  'ComputeLocalePurgeImpactInput',
  'LocalePurgeReport',
  'PageLocaleCounts',
  'PurgeLocaleInput',
  // locks
  'AcquirePageLockInput',
  'PageLockGrant',
  'PageLockState',
  'ReleasePageLockInput',
  'RenewPageLockInput',
  'TakeOverPageLockInput',
]);

/**
 * Names that must stay unreachable from the entry point: every
 * transaction-scoped writer, row-locking read, write-time guard, props
 * validator/constraint applier, and every Drizzle schema table (see
 * `index.ts`'s own header comment for the full rationale behind each).
 */
const WITHHELD: readonly string[] = Object.freeze([
  // revisions.ts
  'recordBlockRevision',
  'pruneBlockRevisions',
  'newRevisionBatchId',
  // pages.ts
  'loadPageForUpdate',
  'recordPageUrlHistory',
  'toPageRecord',
  // placement.ts
  'assertPlacementAllowed',
  'countAncestorSections',
  // page-slug.ts
  'assertPageSlugAvailable',
  'generateUniquePageSlug',
  'composePagePath',
  'pageSlugLockKey',
  'pageSlugConflictFromUniqueViolation',
  'PageSlugGenerationError',
  // page-routing.ts
  'assertPageAddressAvailable',
  'pageUrlCollisionFromUniqueViolation',
  // locks.ts
  'assertPageWritable',
  // registry.ts
  'validateBlockProps',
  'registerResolvedBlocks',
  // constraints.ts
  'applyBlockConstraints',
  // compatibility.ts
  'queryStoredVersionCounts',
  // versioning.ts
  'resolveUpcasterChain',
  'reportDegradedBlock',
  // section-lint.ts
  'reportSectionLint',
  // publish.ts
  'buildSnapshotTree',
  'buildPageSnapshot',
  'computeManifestHash',
  // schema.ts -- every table
  'pages',
  'pageBlocks',
  'blockRevisions',
  'pagePublications',
  'pageUrlHistory',
  'pageEngineSettings',
]);

/** One instance per exported error class, built with representative
 * arguments. A class missing here fails the naming case. */
const ERROR_FACTORIES: Readonly<
  Record<string, (Klass: new (...args: never[]) => unknown) => unknown>
> = Object.freeze({
  PagesConfigError: (K) => new (K as new (i: unknown[]) => unknown)([]),
  BlockConfigError: (K) => new (K as new (i: unknown[]) => unknown)([]),
  BlockPropsValidationError: (K) =>
    new (K as new (i: unknown[]) => unknown)([]),
  UnknownBlockTypeError: (K) =>
    new (K as new (t: string) => unknown)('made_up'),
  BlockConstraintError: (K) => new (K as new (i: unknown[]) => unknown)([]),
  BlockCompatibilityError: (K) =>
    new (K as new (r: unknown) => unknown)({
      incompatible: [],
      belowFloor: [],
    }),
  BlockDepthExceededError: (K) =>
    new (K as new (c: number, a: number) => unknown)(12, 13),
  BlockPlacementError: (K) =>
    new (K as new (
      r: string,
      c: string,
      p: string | null,
      o: string | null,
    ) => unknown)('owner-type', 'hero', null, 'page'),
  SectionNestingDepthExceededError: (K) =>
    new (K as new (c: number, a: number) => unknown)(2, 3),
  SectionRequiredError: (K) => new (K as new (t: string) => unknown)('hero'),
  InvalidPageSlugError: (K) => new (K as new (i: string) => unknown)('---'),
  PageSlugConflictError: (K) =>
    new (K as new (l: string, p: string, e: string | null) => unknown)(
      'en',
      'about',
      'page-id',
    ),
  PageUrlPatternError: (K) => new (K as new (i: unknown[]) => unknown)([]),
  PageEngineSettingsMissingError: (K) => new (K as new () => unknown)(),
  PageUrlCollisionError: (K) =>
    new (K as new (l: string, p: string, e: string | null) => unknown)(
      'en',
      '/about',
      'page-id',
    ),
  PageUrlPatternCollisionError: (K) =>
    new (K as new (c: unknown[]) => unknown)([]),
  CircularPageMoveError: (K) =>
    new (K as new (p: string, d: string) => unknown)('page-id', 'other-id'),
  LocaleMismatchError: (K) =>
    new (K as new (p: string, q: string) => unknown)('en', 'nl'),
  LocaleNotEnabledError: (K) => new (K as new (l: string) => unknown)('de'),
  PageNotFoundError: (K) => new (K as new (id: string) => unknown)('page-id'),
  PagePathConflictError: (K) =>
    new (K as new (p: string, l: string) => unknown)('/about', 'en'),
  StalePageVersionError: (K) =>
    new (K as new (id: string, e: number, a: number) => unknown)(
      'page-id',
      1,
      2,
    ),
  PageTranslationExistsError: (K) =>
    new (K as new (g: string, l: string) => unknown)('group-id', 'nl'),
  BlockNotFoundError: (K) => new (K as new (id: string) => unknown)('block-id'),
  CircularMoveError: (K) =>
    new (K as new (b: string, d: string) => unknown)('block-id', 'other-id'),
  StaleBlockVersionError: (K) =>
    new (K as new (id: string, e: number, a: number) => unknown)(
      'block-id',
      1,
      2,
    ),
  DegradedRestoreError: (K) =>
    new (K as new (o: unknown[]) => unknown)([
      { revisionId: 'rev-id', blockId: 'block-id', blockType: 'hero' },
    ]),
  RestoreTargetNotFoundError: (K) =>
    new (K as new (r: string, b: string) => unknown)('rev-id', 'block-id'),
  RevisionBatchNotFoundError: (K) =>
    new (K as new (id: string) => unknown)('batch-id'),
  DegradedBlockPublishError: (K) =>
    new (K as new (b: unknown[]) => unknown)([
      { blockId: 'block-id', blockType: 'hero', reason: 'no-upcaster' },
    ]),
  AncestorTrashedError: (K) =>
    new (K as new (p: string, a: string) => unknown)('page-id', 'ancestor-id'),
  PageScheduleNotInFutureError: (K) =>
    new (K as new (s: Date, n: Date) => unknown)(new Date(0), new Date(1)),
  PageStatusError: (K) =>
    new (K as new (id: string, s: string, r: string[]) => unknown)(
      'page-id',
      'draft',
      ['published'],
    ),
  LocaleStillEnabledError: (K) => new (K as new (l: string) => unknown)('en'),
  PageLockedError: (K) =>
    new (K as new (id: string, l: string, h: string) => unknown)(
      'page-id',
      'en',
      'user-id',
    ),
  PageLockingDisabledError: (K) => new (K as new () => unknown)(),
  PageLockNotFoundError: (K) =>
    new (K as new (id: string) => unknown)('page-id'),
  PageLockStateChangedError: (K) =>
    new (K as new (id: string) => unknown)('page-id'),
  PageLockTakeoverForbiddenError: (K) =>
    new (K as new (id: string) => unknown)('page-id'),
});

type Documented = { readonly name: string; readonly kind: string };

/** Every `| \`name\` | kind | purpose |` row anywhere under a "Public API"
 * section, including its `### ` subsections. */
function documentedExports(): Documented[] {
  const readme = readFileSync(README_PATH, 'utf8');
  const lines = readme.split('\n');
  const start = lines.findIndex((line) => line.trim() === '## Public API');
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(
    (line) => line.startsWith('## ') && !line.startsWith('### '),
  );
  const section = end === -1 ? rest : rest.slice(0, end);
  return section.flatMap((line) => {
    const match =
      /^\|\s*`([A-Za-z_$][\w$]*)`\s*\|\s*(function|class|constant|type)\s*\|/.exec(
        line,
      );
    return match === null ? [] : [{ name: match[1]!, kind: match[2]! }];
  });
}

/** Every name inside an `export type { ... } from` statement of the barrel. */
function barrelTypeNames(): string[] {
  const source = readFileSync(INDEX_PATH, 'utf8');
  return [...source.matchAll(/export type \{([^}]*)\}\s*from/g)].flatMap(
    (match) =>
      (match[1] ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
  );
}

function sorted(values: Iterable<string>): string[] {
  return [...values].toSorted((a, b) => a.localeCompare(b));
}

function kindOf(value: unknown): ValueKind {
  if (typeof value !== 'function') {
    return 'constant';
  }
  return Function.prototype.toString.call(value).startsWith('class')
    ? 'class'
    : 'function';
}

describe('the @plakboek/pages public surface', () => {
  it('exports every documented value, each of its expected kind', async () => {
    const api: Record<string, unknown> = await import('../../src/index.js');
    const actual = Object.fromEntries(
      Object.keys(PUBLIC_VALUES).map((name) => [name, kindOf(api[name])]),
    );
    expect(actual).toEqual(PUBLIC_VALUES);
  });

  it('exports no value beyond the documented list', async () => {
    const api = await import('../../src/index.js');
    expect(sorted(Object.keys(api))).toEqual(
      sorted(Object.keys(PUBLIC_VALUES)),
    );
  });

  it('keeps every transaction-scoped writer, row-locking read, write-time guard, the props validator/constraint applier and every schema table unreachable', async () => {
    const api: Record<string, unknown> = await import('../../src/index.js');
    for (const name of WITHHELD) {
      expect({ name, value: api[name] }).toEqual({ name, value: undefined });
    }
  });

  it('re-exports each module by name, with no wildcard or default export, and never imports schema.ts', () => {
    const source = readFileSync(INDEX_PATH, 'utf8');
    expect(source).not.toMatch(/export \*/);
    expect(source).not.toMatch(/export default/);
    expect(source).not.toMatch(/from '\.\/(schema)\.js'/);
    expect(sorted(barrelTypeNames())).toEqual(sorted(PUBLIC_TYPES));
  });

  it('names every exported error class after itself, as an Error subclass', async () => {
    const api: Record<string, unknown> = await import('../../src/index.js');
    const classes = Object.entries(PUBLIC_VALUES)
      .filter(([, kind]) => kind === 'class')
      .map(([name]) => name);
    expect(sorted(Object.keys(ERROR_FACTORIES))).toEqual(sorted(classes));

    for (const name of classes) {
      expect({ name, kind: kindOf(api[name]) }).toEqual({
        name,
        kind: 'class',
      });
      const Klass = api[name] as new (...args: never[]) => unknown;
      const factory = ERROR_FACTORIES[name]!;
      const instance = factory(Klass);
      expect({
        name,
        isError: instance instanceof Error,
        ownName: (instance as Error).name,
      }).toEqual({ name, isError: true, ownName: name });
    }
  });
});

describe('README drift', () => {
  it('documents exactly the exported values in its Public API tables, with the same kinds', () => {
    const documented = documentedExports().filter((row) => row.kind !== 'type');
    const byName = Object.fromEntries(
      documented.map((row) => [row.name, row.kind]),
    );
    expect(documented).toHaveLength(Object.keys(byName).length);
    expect(byName).toEqual(PUBLIC_VALUES);
  });

  it('documents exactly the exported types in its Public API tables', () => {
    const documented = documentedExports()
      .filter((row) => row.kind === 'type')
      .map((row) => row.name);
    expect(sorted(documented)).toEqual(sorted(PUBLIC_TYPES));
  });
});
