import {
  acquirePageLock,
  type AcquirePageLockInput,
  AncestorTrashedError,
  assertBlockCompatibility,
  type BelowFloorBlockEntry,
  type BelowFloorEvent,
  BLOCK_CHANGE_TYPES,
  BLOCK_KEY_PATTERN,
  BLOCK_PROPERTY_KEY_PATTERN,
  BLOCK_REVISION_KINDS,
  OWNER_TYPES,
  type BlockChangeType,
  BlockCompatibilityError,
  type BlockCompatibilityReport,
  BlockConfigError,
  type BlockConfigIssue,
  type BlockConfigIssueCode,
  type BlockConstraintIssue,
  type BlockConstraintIssueCode,
  BlockConstraintError,
  type BlockConstraintSet,
  BlockDepthExceededError,
  type BlockDefinitionInput,
  type BlockDeleteImpact,
  type BlockEditorMetadata,
  BlockNotFoundError,
  type BlockNode,
  BlockPlacementError,
  type BlockPlacementReason,
  type BlockPropertyDefinition,
  BlockPropsValidationError,
  type BlockPropsValidationIssue,
  type BlockRecord,
  type BlockRevisionKind,
  type BlockRevisionSummary,
  type BlockUpcaster,
  checkBlockCompatibility,
  checkPageLocales,
  CircularMoveError,
  CircularPageMoveError,
  compactBlockType,
  type CompactBlockTypeInput,
  type CompactionImpact,
  type CompactionImpactEntry,
  type CompactionResult,
  type CompactionSkippedEntry,
  computeBlockDeleteImpact,
  computeBlockRestorePreview,
  type ComputeBlockRestorePreviewInput,
  computeCompactionImpact,
  computeLocalePurgeImpact,
  type ComputeLocalePurgeImpactInput,
  computePagePermanentDeleteImpact,
  computePageResolvedPath,
  type ComputePageResolvedPathInput,
  computePageTrashImpact,
  computeUrlPatternChangeImpact,
  type ComputeUrlPatternChangeImpactInput,
  constrainBlock,
  createDraftSnapshot,
  type CreateDraftSnapshotInput,
  createPage,
  type CreatePageInput,
  createPageTranslation,
  type CreatePageTranslationInput,
  createUpcastSession,
  DEFAULT_BLOCK_DEPTH_CEILING,
  DEFAULT_PAGE_URL_PATTERN,
  DEFAULT_HOME_SLUG,
  DEFAULT_SECTION_NESTING_DEPTH,
  DEGRADED_REASONS,
  DegradedBlockPublishError,
  type DegradedBlockEvent,
  type DegradedReason,
  DegradedRestoreError,
  type DegradedSnapshotBlock,
  defineBlocks,
  definePagesConfig,
  deleteBlock,
  type DeleteBlockInput,
  deletePagePermanently,
  type DeletePagePermanentlyInput,
  getBlockDefinition,
  getPage,
  getPageByPath,
  type GetPageByPathInput,
  getPageEditLocking,
  getPageEngineSettings,
  getPageUrlPattern,
  type IncompatibleBlockEntry,
  InvalidPageSlugError,
  insertBlock,
  type InsertBlockInput,
  InvalidSiblingReferenceError,
  isPageLockLive,
  lintSectionProperties,
  listBatchRevisions,
  listBlockDefinitions,
  listChildPages,
  type ListChildPagesInput,
  listPageRevisionBatches,
  type ListPageRevisionBatchesInput,
  listPageTranslations,
  type ListPageTranslationsInput,
  LocaleMismatchError,
  type LocaleRemovedEvent,
  LocaleNotEnabledError,
  type LocalePurgeReport,
  LocaleStillEnabledError,
  matchPublicPagePath,
  type MatchPublicPagePathInput,
  moveBlock,
  type MoveBlockInput,
  movePage,
  type MovePageInput,
  needsRebalance,
  nextSortOrder,
  PAGE_EDIT_LOCK_HEARTBEAT_SECONDS,
  PAGE_EDIT_LOCK_TTL_SECONDS,
  PAGE_SLUG_LOCK_NAMESPACE,
  PAGE_STATUSES,
  PAGE_URL_PATTERN_MAX_LENGTH,
  PAGE_URL_PATTERN_TOKENS,
  type PageEngineSettings,
  PageEngineSettingsMissingError,
  type PageLocaleCounts,
  PageLockedError,
  type PageLockGrant,
  PageLockingDisabledError,
  PageLockNotFoundError,
  type PageLockState,
  PageLockStateChangedError,
  PageLockTakeoverForbiddenError,
  PageNotFoundError,
  PagePathConflictError,
  type PagePermanentDeleteImpact,
  type PagePublicationRecord,
  type PageRecord,
  PageScheduleNotInFutureError,
  type PageSnapshot,
  type PageStatus,
  PageStatusError,
  type PublicPagePathMatch,
  type PublishedPageSeo,
  type PublishedPageView,
  PageSlugConflictError,
  PageTranslationExistsError,
  type PageTrashImpact,
  PageUrlCollisionError,
  type PageUrlPatternChangeImpact,
  type PageUrlPatternCollision,
  PageUrlPatternCollisionError,
  PageUrlPatternError,
  type PageUrlPatternIssue,
  type PageUrlPatternIssueCode,
  type PageUrlPatternToken,
  type ParsedPageUrlPattern,
  parsePageUrlPattern,
  type PagesConfig,
  type PagesConfigInput,
  type PagesConfigIssue,
  type PagesConfigIssueCode,
  PagesConfigError,
  type PagesDeps,
  type PagesHooks,
  publishPage,
  type PublishPageInput,
  purgeLocale,
  type PurgeLocaleInput,
  rebalancedOrders,
  readBlockTree,
  readLatestDraftSnapshot,
  readPublishedSnapshot,
  releasePageLock,
  type ReleasePageLockInput,
  renamePage,
  type RenamePageInput,
  renewPageLock,
  type RenewPageLockInput,
  reportBelowFloorBlocks,
  reportPageLocaleRemoval,
  reportPagesWarning,
  type ResolvedBlockPlacement,
  type ResolvedBlockProperty,
  type ResolvedPropertyConstraint,
  type ResolvePageUrlPathInput,
  resolveBlockProperties,
  resolvePageUrlPath,
  resolvePublishedPage,
  type ResolvePublishedPageInput,
  resolveVisitorPage,
  type ResolveVisitorPageInput,
  restorePageFromTrash,
  restoreRevisionBatch,
  type RestoreBatchPreview,
  type RestoreBatchResult,
  type RestoreBlockPreview,
  type RestorePropertyOutcome,
  type RestoreRevisionBatchInput,
  RestoreParentNotFoundError,
  RestoreTargetNotFoundError,
  RevisionBatchNotFoundError,
  type RevisionBatchSummary,
  ROOT_PARENT_SENTINEL,
  schedulePage,
  type SchedulePageInput,
  SECTION_LINT_FIELD_TYPES,
  SECTION_LINT_PROPERTY_SUBSTRINGS,
  type SectionLintEvent,
  type SectionLintFinding,
  type SectionLintReason,
  SectionNestingDepthExceededError,
  SectionRequiredError,
  type SetPageEditLockingInput,
  type SetPageEditLockingResult,
  setPageEditLocking,
  type SetPageUrlPatternInput,
  setPageUrlPattern,
  type SnapshotBlock,
  SORT_ORDER_STEP,
  sortOrderBetween,
  StaleBlockVersionError,
  StalePageVersionError,
  takeOverPageLock,
  type TakeOverPageLockInput,
  toPublicPagePath,
  type ToPublicPagePathInput,
  trashPage,
  type TrashPageInput,
  type UnpublishPageInput,
  unpublishPage,
  type UnschedulePageInput,
  unschedulePage,
  UnknownBlockTypeError,
  updateBlockProps,
  type UpdateBlockPropsInput,
  type UpcastOutcome,
  type UpcastSession,
  upcastOnRead,
  type VisitorPageResolution,
} from '@plakboek/pages';
import * as pages from '@plakboek/pages';

// Runtime kind checks. Nothing below opens a connection or applies a
// migration: the only calls made are the pure ones exercised further down.

const functions: Record<string, unknown> = {
  acquirePageLock,
  assertBlockCompatibility,
  checkBlockCompatibility,
  checkPageLocales,
  compactBlockType,
  computeBlockDeleteImpact,
  computeBlockRestorePreview,
  computeCompactionImpact,
  computeLocalePurgeImpact,
  computePagePermanentDeleteImpact,
  computePageResolvedPath,
  computePageTrashImpact,
  computeUrlPatternChangeImpact,
  constrainBlock,
  createDraftSnapshot,
  createPage,
  createPageTranslation,
  createUpcastSession,
  defineBlocks,
  definePagesConfig,
  deleteBlock,
  deletePagePermanently,
  getBlockDefinition,
  getPage,
  getPageByPath,
  getPageEditLocking,
  getPageEngineSettings,
  getPageUrlPattern,
  insertBlock,
  isPageLockLive,
  lintSectionProperties,
  listBatchRevisions,
  listBlockDefinitions,
  listChildPages,
  listPageRevisionBatches,
  listPageTranslations,
  matchPublicPagePath,
  moveBlock,
  movePage,
  needsRebalance,
  nextSortOrder,
  parsePageUrlPattern,
  publishPage,
  purgeLocale,
  rebalancedOrders,
  readBlockTree,
  readLatestDraftSnapshot,
  readPublishedSnapshot,
  releasePageLock,
  renamePage,
  renewPageLock,
  reportBelowFloorBlocks,
  reportPageLocaleRemoval,
  reportPagesWarning,
  resolveBlockProperties,
  resolvePageUrlPath,
  resolvePublishedPage,
  resolveVisitorPage,
  restorePageFromTrash,
  restoreRevisionBatch,
  schedulePage,
  setPageEditLocking,
  setPageUrlPattern,
  sortOrderBetween,
  takeOverPageLock,
  toPublicPagePath,
  trashPage,
  unpublishPage,
  unschedulePage,
  updateBlockProps,
  upcastOnRead,
};

const errorClasses: Record<string, unknown> = {
  AncestorTrashedError,
  BlockCompatibilityError,
  BlockConfigError,
  BlockConstraintError,
  BlockDepthExceededError,
  BlockNotFoundError,
  BlockPlacementError,
  BlockPropsValidationError,
  CircularMoveError,
  CircularPageMoveError,
  DegradedBlockPublishError,
  DegradedRestoreError,
  InvalidPageSlugError,
  InvalidSiblingReferenceError,
  LocaleMismatchError,
  LocaleNotEnabledError,
  LocaleStillEnabledError,
  PageEngineSettingsMissingError,
  PageLockedError,
  PageLockingDisabledError,
  PageLockNotFoundError,
  PageLockStateChangedError,
  PageLockTakeoverForbiddenError,
  PageNotFoundError,
  PagePathConflictError,
  PageScheduleNotInFutureError,
  PageSlugConflictError,
  PagesConfigError,
  PageStatusError,
  PageTranslationExistsError,
  PageUrlCollisionError,
  PageUrlPatternCollisionError,
  PageUrlPatternError,
  RestoreParentNotFoundError,
  RestoreTargetNotFoundError,
  RevisionBatchNotFoundError,
  SectionNestingDepthExceededError,
  SectionRequiredError,
  StaleBlockVersionError,
  StalePageVersionError,
  UnknownBlockTypeError,
};

const numbers: Record<string, unknown> = {
  DEFAULT_BLOCK_DEPTH_CEILING,
  DEFAULT_SECTION_NESTING_DEPTH,
  PAGE_EDIT_LOCK_HEARTBEAT_SECONDS,
  PAGE_EDIT_LOCK_TTL_SECONDS,
  PAGE_SLUG_LOCK_NAMESPACE,
  PAGE_URL_PATTERN_MAX_LENGTH,
  SORT_ORDER_STEP,
};

const regexPatterns: Record<string, unknown> = {
  BLOCK_KEY_PATTERN,
  BLOCK_PROPERTY_KEY_PATTERN,
};

const strings: Record<string, unknown> = {
  DEFAULT_HOME_SLUG,
  DEFAULT_PAGE_URL_PATTERN,
  ROOT_PARENT_SENTINEL,
};

const frozenArrays: Record<string, unknown> = {
  BLOCK_CHANGE_TYPES,
  BLOCK_REVISION_KINDS,
  DEGRADED_REASONS,
  OWNER_TYPES,
  PAGE_STATUSES,
  PAGE_URL_PATTERN_TOKENS,
  SECTION_LINT_FIELD_TYPES,
  SECTION_LINT_PROPERTY_SUBSTRINGS,
};

function fail(reason: string): never {
  console.error(`pages.ts: ${reason}`);
  process.exit(1);
}

for (const [name, value] of Object.entries(functions)) {
  if (typeof value !== 'function') {
    fail(`${name} is not a function`);
  }
}

for (const [name, value] of Object.entries(errorClasses)) {
  if (
    typeof value !== 'function' ||
    !(value.prototype instanceof Error) ||
    !Function.prototype.toString.call(value).startsWith('class')
  ) {
    fail(`${name} is not an Error subclass`);
  }
}

for (const [name, value] of Object.entries(numbers)) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail(`${name} is not a positive integer`);
  }
}

for (const [name, value] of Object.entries(regexPatterns)) {
  if (!(value instanceof RegExp)) {
    fail(`${name} is not a regular expression`);
  }
}

for (const [name, value] of Object.entries(strings)) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${name} is not a non-empty string`);
  }
}

for (const [name, value] of Object.entries(frozenArrays)) {
  if (!Array.isArray(value) || value.length === 0 || !Object.isFrozen(value)) {
    fail(`${name} is not a non-empty frozen array`);
  }
}

const documentedValueCount =
  Object.keys(functions).length +
  Object.keys(errorClasses).length +
  Object.keys(numbers).length +
  Object.keys(regexPatterns).length +
  Object.keys(strings).length +
  Object.keys(frozenArrays).length;

const exportedNames = Object.keys(pages);
if (exportedNames.length !== documentedValueCount) {
  fail(
    `the entry point exports ${exportedNames.length} values, the probe knows ${documentedValueCount}`,
  );
}

// Every transaction-scoped writer, row-locking read, write-time guard, the
// props validator/constraint applier and a representative sample of the
// schema tables must stay unreachable.
const reachable: Record<string, unknown> = pages;
for (const internal of [
  'recordBlockRevision',
  'pruneBlockRevisions',
  'newRevisionBatchId',
  'loadPageForUpdate',
  'recordPageUrlHistory',
  'toPageRecord',
  'assertPlacementAllowed',
  'countAncestorSections',
  'assertPageSlugAvailable',
  'generateUniquePageSlug',
  'assertPageAddressAvailable',
  'assertPageWritable',
  'validateBlockProps',
  'applyBlockConstraints',
  'buildSnapshotTree',
  'pages',
  'pageBlocks',
  'blockRevisions',
  'pagePublications',
  'pageUrlHistory',
  'pageEngineSettings',
]) {
  if (reachable[internal] !== undefined) {
    fail(`${internal} must not be reachable from the entry point`);
  }
}

// Pure calls: no connection is opened and no migration is applied.

const blockInputs: BlockDefinitionInput[] = [
  {
    key: 'hero',
    kind: 'section',
    editor: { label: 'Hero' },
    properties: {
      title: { fieldType: 'short_text', label: 'Title', required: true },
    },
    schemaVersion: 1,
  },
];
const blocks = defineBlocks(blockInputs);
if (blocks.length !== 1 || blocks[0]?.key !== 'hero') {
  fail('defineBlocks did not register the one declared block');
}

const heroDefinition = getBlockDefinition('hero');
if (listBlockDefinitions().length !== 1) {
  fail('listBlockDefinitions did not return the one registered block');
}

const resolvedProperties = resolveBlockProperties(heroDefinition);
const resolvedTitleProperty = resolvedProperties.title;
if (resolvedTitleProperty === undefined) {
  fail('resolveBlockProperties did not resolve the declared "title" property');
}

const constraintSet: BlockConstraintSet = constrainBlock('hero', {
  title: 'hidden',
});
if (
  !Object.isFrozen(constraintSet) ||
  !Object.isFrozen(constraintSet.properties)
) {
  fail('constrainBlock did not return a frozen set');
}

const lintFindings = lintSectionProperties(blocks);
if (!Array.isArray(lintFindings)) {
  fail('lintSectionProperties did not return an array');
}

const identityUpcast = upcastOnRead(
  heroDefinition,
  heroDefinition.schemaVersion,
  {
    title: 'Hello',
  },
);
if (identityUpcast.degraded !== false) {
  fail(
    'upcastOnRead on an identity case (stored version === schemaVersion) reported degraded',
  );
}

const session = createUpcastSession();
const sessionUpcast = session.upcast('hero', heroDefinition.schemaVersion, {
  title: 'Hello',
});
if (sessionUpcast.degraded !== false) {
  fail('createUpcastSession().upcast on an identity case reported degraded');
}

const parsedPattern = parsePageUrlPattern('{locale}/{path}');
const resolvedPath = resolvePageUrlPath(parsedPattern, {
  locale: 'en',
  path: 'about',
});
if (resolvedPath !== 'en/about') {
  fail(
    'parsePageUrlPattern/resolvePageUrlPath did not render the expected path',
  );
}

const publicMatch: PublicPagePathMatch = matchPublicPagePath(
  '{locale}/{path}',
  {
    publicPath: '/nl/x',
    locales: ['en', 'nl'],
    defaultLocale: 'en',
    homeSlug: DEFAULT_HOME_SLUG,
  },
);
if (publicMatch.kind !== 'match' || publicMatch.locale !== 'nl') {
  fail('matchPublicPagePath did not match /nl/x to the nl locale');
}
if (
  toPublicPagePath('{locale}/{path}', {
    locale: 'nl',
    path: 'x',
    defaultLocale: 'en',
    homeSlug: DEFAULT_HOME_SLUG,
  }) !== '/nl/x'
) {
  fail('toPublicPagePath did not invert the matched address');
}

const lockedAt = new Date(0);
if (
  !isPageLockLive('user-id', lockedAt, new Date(lockedAt.getTime() + 119_999))
) {
  fail('isPageLockLive reported lapsed 1ms before the TTL boundary');
}
if (
  isPageLockLive('user-id', lockedAt, new Date(lockedAt.getTime() + 120_000))
) {
  fail('isPageLockLive reported live exactly at the TTL boundary');
}

if (sortOrderBetween(1000, 3000) !== 2000) {
  fail('sortOrderBetween did not return the midpoint of two orders');
}
if (sortOrderBetween(null, null) !== SORT_ORDER_STEP) {
  fail('sortOrderBetween did not return SORT_ORDER_STEP for an empty list');
}
if (nextSortOrder(null) !== SORT_ORDER_STEP) {
  fail('nextSortOrder did not return SORT_ORDER_STEP for an empty list');
}
if (needsRebalance(1000, 1001) !== true) {
  fail('needsRebalance did not detect a closed gap');
}
if (
  rebalancedOrders(2).join(',') !==
  [SORT_ORDER_STEP, SORT_ORDER_STEP * 2].join(',')
) {
  fail('rebalancedOrders did not return evenly-spaced fresh orders');
}

// Type proofs: one declaration per exported type not already bound above, so
// the packed declarations must resolve every name for this file to
// type-check. Nothing here is ever called or awaited unless noted above.

const localeRemovedEvent: LocaleRemovedEvent = {
  locale: 'de',
  pageCount: 0,
  occurredAt: new Date(0),
};
const pagesConfigInput: PagesConfigInput = {
  content: { locales: ['en', 'nl'], defaultLocale: 'en', timezone: 'UTC' },
  blocks,
};
const config: PagesConfig = definePagesConfig(pagesConfigInput);
if (!Object.isFrozen(config)) {
  fail('definePagesConfig did not return a frozen config');
}
const pagesConfigIssueCode: PagesConfigIssueCode = 'NO_BLOCKS';
const pagesConfigIssue: PagesConfigIssue = {
  code: 'NO_BLOCKS',
  message: 'no blocks configured',
};
const pagesHooks: PagesHooks = {};

const blockChangeType: BlockChangeType = 'create';
const blockNode: BlockNode = {
  id: 'block-id',
  ownerType: 'page',
  ownerId: 'page-id',
  locale: 'en',
  parentBlockId: null,
  blockType: 'hero',
  props: {},
  schemaVersion: 1,
  depth: 0,
  sortOrder: 1000,
  version: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  degraded: false,
  children: [],
};
const blockRecord: BlockRecord = {
  id: 'block-id',
  ownerType: 'page',
  ownerId: 'page-id',
  locale: 'en',
  parentBlockId: null,
  blockType: 'hero',
  props: {},
  schemaVersion: 1,
  depth: 0,
  sortOrder: 1000,
  version: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const blockRevisionKind: BlockRevisionKind = 'save';
const pageStatus: PageStatus = 'draft';
const pageRecord: PageRecord = {
  id: 'page-id',
  translationGroup: 'group-id',
  locale: 'en',
  parentPageId: null,
  slug: 'home',
  slugSource: 'generated',
  path: 'home',
  resolvedPath: null,
  title: 'Home',
  status: 'draft',
  seo: null,
  version: 1,
  livePublicationId: null,
  lockedBy: null,
  lockedAt: null,
  createdBy: null,
  updatedBy: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  publishedAt: null,
  firstPublishedAt: null,
  scheduledAt: null,
  trashedAt: null,
};

const blockConfigIssueCode: BlockConfigIssueCode = 'INVALID_KEY';
const blockConfigIssue: BlockConfigIssue = {
  code: 'INVALID_KEY',
  blockKey: 'x',
  message: 'invalid key',
};
const blockEditorMetadata: BlockEditorMetadata = { label: 'Hero' };
const blockPropertyDefinition: BlockPropertyDefinition = {
  fieldType: 'short_text',
  label: 'Title',
};
const blockPropsValidationIssue: BlockPropsValidationIssue = {
  propertyKey: 'title',
  code: 'REQUIRED',
};
const blockUpcaster: BlockUpcaster = (props) => props;
const resolvedBlockPlacement: ResolvedBlockPlacement = heroDefinition.placement;
const resolvedBlockProperty: ResolvedBlockProperty = resolvedTitleProperty;
const resolvedPropertyConstraint: ResolvedPropertyConstraint = {
  kind: 'hidden',
};

const blockConstraintIssueCode: BlockConstraintIssueCode = 'UNKNOWN_BLOCK';
const blockConstraintIssue: BlockConstraintIssue = {
  code: 'UNKNOWN_BLOCK',
  blockKey: 'x',
  message: 'unknown block',
};

const belowFloorBlockEntry: BelowFloorBlockEntry = {
  blockKey: 'hero',
  storedVersions: [1],
  minSupportedVersion: 2,
  instanceCount: 1,
};
const belowFloorEvent: BelowFloorEvent = {
  ...belowFloorBlockEntry,
  occurredAt: new Date(0),
};
const blockCompatibilityReport: BlockCompatibilityReport = {
  incompatible: [],
  belowFloor: [],
};
const incompatibleBlockEntry: IncompatibleBlockEntry = {
  blockKey: 'hero',
  storedVersions: [1],
  currentVersion: 2,
  missingSteps: [2],
};

const sectionLintEvent: SectionLintEvent = {
  findings: [],
  occurredAt: new Date(0),
};
const sectionLintFinding: SectionLintFinding = {
  blockKey: 'hero',
  reason: 'exempt',
  detail: 'opted out',
};
const sectionLintReason: SectionLintReason = 'exempt';

const blockPlacementReason: BlockPlacementReason = 'owner-type';

const degradedBlockEvent: DegradedBlockEvent = {
  blockId: 'block-id',
  blockType: 'hero',
  storedVersion: 1,
  currentVersion: 2,
  reason: 'no-upcaster',
  occurredAt: new Date(0),
};
const degradedReason: DegradedReason = 'no-upcaster';
const upcastOutcome: UpcastOutcome = identityUpcast;
const upcastSession: UpcastSession = session;

const compactBlockTypeInput: CompactBlockTypeInput = { blockKey: 'hero' };
const compactionImpact: CompactionImpact = {
  blockKey: 'hero',
  currentVersion: 1,
  byStoredVersion: [],
  upcastableCount: 0,
  blockedCount: 0,
};
const compactionImpactEntry: CompactionImpactEntry = {
  version: 1,
  instanceCount: 1,
  upcastable: true,
};
const compactionResult: CompactionResult = {
  blockKey: 'hero',
  rewritten: 0,
  skipped: [],
  batches: 0,
};
const compactionSkippedEntry: CompactionSkippedEntry = {
  blockId: 'block-id',
  storedVersion: 1,
  reason: 'no-upcaster',
};

const pageUrlPatternIssue: PageUrlPatternIssue = {
  code: 'EMPTY_PATTERN',
  message: 'pattern is empty',
};
const pageUrlPatternIssueCode: PageUrlPatternIssueCode = 'EMPTY_PATTERN';
const pageUrlPatternToken: PageUrlPatternToken = 'locale';
const resolvePageUrlPathInput: ResolvePageUrlPathInput = {
  locale: 'en',
  path: 'about',
};
const parsedPageUrlPattern: ParsedPageUrlPattern = parsedPattern;

const pageEngineSettings: PageEngineSettings = {
  pageEditLocking: true,
  urlPattern: DEFAULT_PAGE_URL_PATTERN,
  updatedAt: new Date(0),
};
const setPageEditLockingInput: SetPageEditLockingInput = { enabled: true };
const setPageEditLockingResult: SetPageEditLockingResult = {
  previous: true,
  current: false,
};

const computePageResolvedPathInput: ComputePageResolvedPathInput = {
  pattern: parsedPattern,
  locale: 'en',
  path: 'about',
};
const computeUrlPatternChangeImpactInput: ComputeUrlPatternChangeImpactInput = {
  newPattern: '{locale}/{path}',
};
const pageUrlPatternCollision: PageUrlPatternCollision = {
  resolvedPath: '/about',
  pageIds: ['page-a', 'page-b'],
};
const pageUrlPatternChangeImpact: PageUrlPatternChangeImpact = {
  currentPattern: '{locale}/{path}',
  newPattern: '{locale}/{path}',
  changedCount: 0,
  unchangedCount: 0,
  collisions: [],
};
const setPageUrlPatternInput: SetPageUrlPatternInput = {
  newPattern: '{locale}/{path}',
};

const createPageInput: CreatePageInput = { locale: 'en', title: 'Home' };
const getPageByPathInput: GetPageByPathInput = { locale: 'en', path: 'home' };
const listChildPagesInput: ListChildPagesInput = {
  parentPageId: null,
  locale: 'en',
};
const movePageInput: MovePageInput = {
  pageId: 'page-id',
  baseVersion: 1,
  newParentPageId: null,
};
const renamePageInput: RenamePageInput = { pageId: 'page-id', baseVersion: 1 };

const createPageTranslationInput: CreatePageTranslationInput = {
  pageId: 'page-id',
  locale: 'nl',
};
const listPageTranslationsInput: ListPageTranslationsInput = {
  translationGroup: 'group-id',
};

const blockDeleteImpact: BlockDeleteImpact = {
  blockId: 'block-id',
  blockCount: 1,
  blockTypes: ['hero'],
  revisionCount: 0,
};
const deleteBlockInput: DeleteBlockInput = {
  blockId: 'block-id',
  baseVersion: 1,
  pageId: 'page-id',
  basePageVersion: 1,
};
const insertBlockInput: InsertBlockInput = {
  owner: { ownerType: 'page', ownerId: 'page-id', locale: 'en' },
  blockType: 'hero',
  parentBlockId: null,
  basePageVersion: 1,
};
const moveBlockInput: MoveBlockInput = {
  blockId: 'block-id',
  baseVersion: 1,
  pageId: 'page-id',
  basePageVersion: 1,
  newParentBlockId: null,
};
const updateBlockPropsInput: UpdateBlockPropsInput = {
  blockId: 'block-id',
  baseVersion: 1,
  props: {},
};

const blockRevisionSummary: BlockRevisionSummary = {
  id: 'revision-id',
  blockId: 'block-id',
  blockType: 'hero',
  changeType: 'create',
  kind: 'save',
  parentBlockId: null,
  sortOrder: 1000,
  depth: 0,
  props: {},
  schemaVersion: 1,
  authorId: null,
  createdAt: new Date(0),
};
const computeBlockRestorePreviewInput: ComputeBlockRestorePreviewInput = {
  revisionBatchId: 'batch-id',
};
const listPageRevisionBatchesInput: ListPageRevisionBatchesInput = {
  pageId: 'page-id',
  locale: 'en',
};
const restoreBlockPreview: RestoreBlockPreview = {
  revisionId: 'revision-id',
  blockId: 'block-id',
  blockType: 'hero',
  changeType: 'create',
  storedVersion: 1,
  currentVersion: 1,
  properties: [],
};
const restoreBatchPreview: RestoreBatchPreview = {
  revisionBatchId: 'batch-id',
  pageId: 'page-id',
  locale: 'en',
  blocks: [restoreBlockPreview],
  mappedCount: 0,
  defaultedCount: 0,
  droppedCount: 0,
  failedCount: 0,
};
const restoreBatchResult: RestoreBatchResult = {
  revisionBatchId: 'batch-id',
  restoredBlocks: 0,
};
const restorePropertyOutcome: RestorePropertyOutcome = {
  propertyKey: 'title',
  status: 'mapped',
};
const restoreRevisionBatchInput: RestoreRevisionBatchInput = {
  revisionBatchId: 'batch-id',
  pageId: 'page-id',
  basePageVersion: 1,
};
const revisionBatchSummary: RevisionBatchSummary = {
  revisionBatchId: 'batch-id',
  createdAt: new Date(0),
  authorId: null,
  blockCount: 1,
  changeTypes: ['create'],
  kind: 'save',
};

const createDraftSnapshotInput: CreateDraftSnapshotInput = {
  pageId: 'page-id',
};
const degradedSnapshotBlock: DegradedSnapshotBlock = {
  blockId: 'block-id',
  blockType: 'hero',
  reason: 'no-upcaster',
};
const pageSnapshot: PageSnapshot = { blocks: [] };
const snapshotBlock: SnapshotBlock = {
  id: 'block-id',
  blockType: 'hero',
  schemaVersion: 1,
  props: {},
  children: [],
};
const pagePublicationRecord: PagePublicationRecord = {
  id: 'publication-id',
  pageId: 'page-id',
  locale: 'en',
  isDraft: false,
  snapshot: pageSnapshot,
  revisionManifest: {},
  manifestHash: 'hash',
  publishedBy: null,
  publishedAt: new Date(0),
};
const publishPageInput: PublishPageInput = {
  pageId: 'page-id',
  baseVersion: 1,
};

const deletePagePermanentlyInput: DeletePagePermanentlyInput = {
  pageId: 'page-id',
  baseVersion: 1,
};
const pagePermanentDeleteImpact: PagePermanentDeleteImpact = {
  pageId: 'page-id',
  pageCount: 1,
  blockCount: 0,
  blockRevisionCount: 0,
  publicationCount: 0,
  urlHistoryCount: 0,
};
const pageTrashImpact: PageTrashImpact = {
  pageId: 'page-id',
  pageCount: 1,
  publishedCount: 0,
  blockCount: 0,
};
const schedulePageInput: SchedulePageInput = {
  pageId: 'page-id',
  baseVersion: 1,
  scheduledAt: new Date(0),
};
const trashPageInput: TrashPageInput = { pageId: 'page-id', baseVersion: 1 };
const unpublishPageInput: UnpublishPageInput = {
  pageId: 'page-id',
  baseVersion: 1,
};
const unschedulePageInput: UnschedulePageInput = {
  pageId: 'page-id',
  baseVersion: 1,
};

const computeLocalePurgeImpactInput: ComputeLocalePurgeImpactInput = {
  locale: 'de',
};
const pageLocaleCounts: PageLocaleCounts = {
  locale: 'de',
  pageCount: 0,
  blockCount: 0,
  blockRevisionCount: 0,
  publicationCount: 0,
  urlHistoryCount: 0,
};
const localePurgeReport: LocalePurgeReport = {
  locale: 'de',
  pages: pageLocaleCounts,
  entries: {
    locale: 'de',
    entryCount: 0,
    revisionCount: 0,
    urlHistoryCount: 0,
    referenceCount: 0,
    translationGroupsAffected: 0,
  },
};
const purgeLocaleInput: PurgeLocaleInput = { locale: 'de' };

const acquirePageLockInput: AcquirePageLockInput = { pageId: 'page-id' };
const pageLockGrant: PageLockGrant = {
  lockedAt: new Date(0),
  expiresAt: new Date(120_000),
};
const pageLockState: PageLockState = {
  id: 'page-id',
  locale: 'en',
  version: 1,
  lockedBy: null,
  lockedAt: null,
};
const releasePageLockInput: ReleasePageLockInput = { pageId: 'page-id' };
const renewPageLockInput: RenewPageLockInput = { pageId: 'page-id' };
const takeOverPageLockInput: TakeOverPageLockInput = { pageId: 'page-id' };

const matchPublicPagePathInput: MatchPublicPagePathInput = {
  publicPath: '/',
  locales: ['en'],
  defaultLocale: 'en',
  homeSlug: DEFAULT_HOME_SLUG,
};
const toPublicPagePathInput: ToPublicPagePathInput = {
  locale: 'en',
  path: 'home',
  defaultLocale: 'en',
  homeSlug: DEFAULT_HOME_SLUG,
};
const publishedPageSeo: PublishedPageSeo = {
  title: null,
  description: null,
  imageAssetId: null,
  canonicalUrl: null,
  noindex: false,
  nofollow: false,
};
const publishedPageView: PublishedPageView = {
  page: {
    id: 'page-id',
    locale: 'en',
    title: 'Home',
    resolvedPath: 'en/home',
    seo: publishedPageSeo,
  },
  publication: {
    id: 'publication-id',
    manifestHash: 'hash',
    publishedAt: new Date(0),
    snapshot: pageSnapshot,
  },
};
const resolvePublishedPageInput: ResolvePublishedPageInput = {
  locale: 'en',
  resolvedPath: 'en/home',
};
const resolveVisitorPageInput: ResolveVisitorPageInput =
  matchPublicPagePathInput;
const visitorPageResolution: VisitorPageResolution = {
  kind: 'page',
  publicPath: '/',
  view: publishedPageView,
};

// PagesDeps needs live db/recorder/resolver handles this probe never opens
// -- proven only as a parameter type of a never-called function, the same
// technique plan 03-14 used for @plakboek/content's `ContentDeps`.
function neverCalled(_deps: PagesDeps): number {
  return 1;
}

const typeProofs: unknown[] = [
  localeRemovedEvent,
  pagesConfigInput,
  pagesConfigIssueCode,
  pagesConfigIssue,
  pagesHooks,
  blockChangeType,
  blockNode,
  blockRecord,
  blockRevisionKind,
  pageStatus,
  pageRecord,
  blockConfigIssueCode,
  blockConfigIssue,
  blockEditorMetadata,
  blockPropertyDefinition,
  blockPropsValidationIssue,
  blockUpcaster,
  resolvedBlockPlacement,
  resolvedBlockProperty,
  resolvedPropertyConstraint,
  blockConstraintIssueCode,
  blockConstraintIssue,
  belowFloorBlockEntry,
  belowFloorEvent,
  blockCompatibilityReport,
  incompatibleBlockEntry,
  sectionLintEvent,
  sectionLintFinding,
  sectionLintReason,
  blockPlacementReason,
  degradedBlockEvent,
  degradedReason,
  upcastOutcome,
  upcastSession,
  compactBlockTypeInput,
  compactionImpact,
  compactionImpactEntry,
  compactionResult,
  compactionSkippedEntry,
  pageUrlPatternIssue,
  pageUrlPatternIssueCode,
  pageUrlPatternToken,
  resolvePageUrlPathInput,
  parsedPageUrlPattern,
  pageEngineSettings,
  setPageEditLockingInput,
  setPageEditLockingResult,
  computePageResolvedPathInput,
  computeUrlPatternChangeImpactInput,
  pageUrlPatternCollision,
  pageUrlPatternChangeImpact,
  setPageUrlPatternInput,
  createPageInput,
  getPageByPathInput,
  listChildPagesInput,
  movePageInput,
  renamePageInput,
  createPageTranslationInput,
  listPageTranslationsInput,
  blockDeleteImpact,
  deleteBlockInput,
  insertBlockInput,
  moveBlockInput,
  updateBlockPropsInput,
  blockRevisionSummary,
  computeBlockRestorePreviewInput,
  listPageRevisionBatchesInput,
  restoreBlockPreview,
  restoreBatchPreview,
  restoreBatchResult,
  restorePropertyOutcome,
  restoreRevisionBatchInput,
  revisionBatchSummary,
  createDraftSnapshotInput,
  degradedSnapshotBlock,
  pageSnapshot,
  snapshotBlock,
  pagePublicationRecord,
  publishPageInput,
  deletePagePermanentlyInput,
  pagePermanentDeleteImpact,
  pageTrashImpact,
  schedulePageInput,
  trashPageInput,
  unpublishPageInput,
  unschedulePageInput,
  computeLocalePurgeImpactInput,
  pageLocaleCounts,
  localePurgeReport,
  purgeLocaleInput,
  acquirePageLockInput,
  pageLockGrant,
  pageLockState,
  releasePageLockInput,
  renewPageLockInput,
  takeOverPageLockInput,
  matchPublicPagePathInput,
  toPublicPagePathInput,
  publishedPageSeo,
  publishedPageView,
  resolvePublishedPageInput,
  resolveVisitorPageInput,
  visitorPageResolution,
  publicMatch,
  config,
];

console.log(
  `pages.ts: ${documentedValueCount} values of the expected kinds and ${typeProofs.length + neverCalled.length} typed declarations resolve against the packed package (no connection opened, no migration applied)`,
);
