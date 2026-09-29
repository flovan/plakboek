/**
 * Public barrel for @plakboek/pages, complete as of plan 04-15.
 *
 * Named re-exports only, grouped by module, values and types in separate
 * statements -- mirrors @plakboek/content's barrel discipline.
 * `tests/unit/public-api.test.ts` holds this surface to one literal list and
 * to the README's Public API tables, so adding or removing an export means
 * changing all three together.
 *
 * Deliberately absent, and why: a consumer able to reach any of these could
 * write or read pages/blocks around the audited, version-checked,
 * locale-filtered paths this package guarantees.
 *
 * - The block-revision writer and the cap-pruning sweep (`revisions.ts`) --
 *   called only from this package's own write paths, inside an
 *   already-open audited transaction. One save call to this package's own
 *   revision history.
 * - The row-locking page read (`pages.ts`) and the append-only URL-history
 *   writer -- every host-facing read excludes a removed locale and every
 *   history row is written inside the transaction that changed the address;
 *   a caller reaching either directly could lock a page row or write history
 *   outside any audited mutation.
 * - The write-time placement, depth and section guards (`placement.ts`) and
 *   the ancestor walk behind them -- reachable only through the write paths
 *   that must obey them, never callable standalone to pre-check a write a
 *   caller then performs some other way.
 * - Transaction-scoped slug generation and availability, and the
 *   address-availability check (`page-slug.ts`, `page-routing.ts`) -- the
 *   advisory-lock-serialised search a concurrent write must go through, not
 *   a preview a caller runs on its own.
 * - The edit-lock write guard every mutation calls internally (`locks.ts`) --
 *   reachable only from inside this package's own audited writes, never as
 *   a standalone check a caller could run out of step with the write it
 *   guards.
 * - The shared publication materialiser (`publish.ts`) -- the single code
 *   path that makes a preview and a publish identical; a second caller could
 *   make them differ.
 * - The props validator and the constraint applier (`registry.ts`,
 *   `constraints.ts`) -- reachable only through `resolveBlockProperties` and
 *   the write paths; a caller validating props outside a real write could
 *   diverge from what the write path actually persists.
 * - Every Drizzle schema table -- a consumer able to read or write these
 *   directly could bypass every guarantee above.
 *
 * A second tier of internal helpers stays unexported for the same reason,
 * even though the plan's own withheld list does not name every one
 * individually: the aggregate stored-version read and the pure upcaster-
 * chain resolver behind `checkBlockCompatibility`/`upcastOnRead`
 * (`queryStoredVersionCounts`, `resolveUpcasterChain`, `compatibility.ts`/
 * `versioning.ts`); the per-event reporters `definePagesConfig` and
 * `readBlockTree` already call automatically at boot or on read
 * (`reportSectionLint`, `reportDegradedBlock`) -- a host never needs to fire
 * these itself, only to supply the hook they call; the snapshot-assembly
 * internals `materialisePublication` alone calls (`buildSnapshotTree`,
 * `buildPageSnapshot`, `computeManifestHash`, `publish.ts`) -- a host reads
 * the finished record through `publishPage`/`createDraftSnapshot`/
 * `readPublishedSnapshot`/`readLatestDraftSnapshot`, never assembles one
 * itself; the revision-batch id minter (`newRevisionBatchId`, `revisions.ts`)
 * and the row-to-record mapper (`toPageRecord`, `pages.ts`), both internal
 * wiring with no reason for a caller to invoke directly; and the two
 * unique-violation-to-domain-error mappers (`pageSlugConflictFromUniqueViolation`,
 * `pageUrlCollisionFromUniqueViolation`) plus the pure path/lock-key
 * composers behind them (`composePagePath`, `pageSlugLockKey`) and the
 * practically-unreachable `PageSlugGenerationError` -- mirrors
 * `@plakboek/content`'s identical choice to keep its own equivalents
 * (`slugConflictFromUniqueViolation`, `urlCollisionFromUniqueViolation`,
 * `SlugGenerationError`) internal.
 */

// config.ts
export {
  DEFAULT_BLOCK_DEPTH_CEILING,
  DEFAULT_SECTION_NESTING_DEPTH,
  definePagesConfig,
  PagesConfigError,
  reportPagesWarning,
} from './config.js';
export type {
  LocaleRemovedEvent,
  PagesConfig,
  PagesConfigInput,
  PagesConfigIssue,
  PagesConfigIssueCode,
  PagesDeps,
  PagesHooks,
} from './config.js';

// types.ts
export {
  BLOCK_CHANGE_TYPES,
  BLOCK_REVISION_KINDS,
  OWNER_TYPES,
  PAGE_STATUSES,
} from './types.js';
export type {
  BlockChangeType,
  BlockNode,
  BlockRecord,
  BlockRevisionKind,
  OwnerRef,
  OwnerType,
  PageRecord,
  PageStatus,
} from './types.js';

// registry.ts
export {
  BLOCK_KEY_PATTERN,
  BLOCK_PROPERTY_KEY_PATTERN,
  BlockConfigError,
  BlockPropsValidationError,
  defineBlocks,
  getBlockDefinition,
  listBlockDefinitions,
  resolveBlockProperties,
  UnknownBlockTypeError,
} from './registry.js';
export type {
  BlockConfigIssue,
  BlockConfigIssueCode,
  BlockDefinition,
  BlockDefinitionInput,
  BlockEditorMetadata,
  BlockKind,
  BlockPlacement,
  BlockPropertyDefinition,
  BlockPropsValidationIssue,
  BlockUpcaster,
  ResolvedBlockPlacement,
  ResolvedBlockProperty,
  ResolvedPropertyConstraint,
} from './registry.js';

// constraints.ts
export { BlockConstraintError, constrainBlock } from './constraints.js';
export type {
  BlockConstraintIssue,
  BlockConstraintIssueCode,
  BlockConstraintSet,
  PropertyConstraint,
} from './constraints.js';

// compatibility.ts
export {
  assertBlockCompatibility,
  BlockCompatibilityError,
  checkBlockCompatibility,
} from './compatibility.js';
export type {
  BelowFloorBlockEntry,
  BelowFloorEvent,
  BlockCompatibilityReport,
  IncompatibleBlockEntry,
} from './compatibility.js';

// section-lint.ts
export {
  lintSectionProperties,
  SECTION_LINT_FIELD_TYPES,
  SECTION_LINT_PROPERTY_SUBSTRINGS,
} from './section-lint.js';
export type {
  SectionLintEvent,
  SectionLintFinding,
  SectionLintReason,
} from './section-lint.js';

// placement.ts
export {
  BlockDepthExceededError,
  BlockPlacementError,
  ROOT_PARENT_SENTINEL,
  SectionNestingDepthExceededError,
  SectionRequiredError,
} from './placement.js';
export type { BlockPlacementReason } from './placement.js';

// versioning.ts
export {
  createUpcastSession,
  DEGRADED_REASONS,
  upcastOnRead,
} from './versioning.js';
export type {
  DegradedBlockEvent,
  DegradedReason,
  UpcastOutcome,
  UpcastSession,
} from './versioning.js';

// compaction.ts
export {
  compactBlockType,
  computeCompactionImpact,
  reportBelowFloorBlocks,
} from './compaction.js';
export type {
  CompactBlockTypeInput,
  CompactionImpact,
  CompactionImpactEntry,
  CompactionResult,
  CompactionSkippedEntry,
} from './compaction.js';

// ordering.ts
export {
  needsRebalance,
  nextSortOrder,
  rebalancedOrders,
  SORT_ORDER_STEP,
  sortOrderBetween,
} from './ordering.js';

// page-slug.ts
export {
  InvalidPageSlugError,
  PAGE_SLUG_LOCK_NAMESPACE,
  PageSlugConflictError,
} from './page-slug.js';

// page-url-pattern.ts
export {
  DEFAULT_PAGE_URL_PATTERN,
  PAGE_URL_PATTERN_MAX_LENGTH,
  PAGE_URL_PATTERN_TOKENS,
  PageUrlPatternError,
  parsePageUrlPattern,
  resolvePageUrlPath,
} from './page-url-pattern.js';
export type {
  ParsedPageUrlPattern,
  PageUrlPatternIssue,
  PageUrlPatternIssueCode,
  PageUrlPatternToken,
  ResolvePageUrlPathInput,
} from './page-url-pattern.js';

// settings.ts
export {
  getPageEditLocking,
  getPageEngineSettings,
  getPageUrlPattern,
  PageEngineSettingsMissingError,
  setPageEditLocking,
} from './settings.js';
export type {
  PageEngineSettings,
  SetPageEditLockingInput,
  SetPageEditLockingResult,
} from './settings.js';

// page-routing.ts
export {
  computePageResolvedPath,
  computeUrlPatternChangeImpact,
  PageUrlCollisionError,
  PageUrlPatternCollisionError,
  setPageUrlPattern,
} from './page-routing.js';
export type {
  ComputePageResolvedPathInput,
  ComputeUrlPatternChangeImpactInput,
  PageUrlPatternChangeImpact,
  PageUrlPatternCollision,
  SetPageUrlPatternInput,
} from './page-routing.js';

// pages.ts
export {
  CircularPageMoveError,
  createPage,
  getPage,
  getPageByPath,
  listChildPages,
  LocaleMismatchError,
  LocaleNotEnabledError,
  movePage,
  PageNotFoundError,
  PagePathConflictError,
  renamePage,
  StalePageVersionError,
} from './pages.js';
export type {
  CreatePageInput,
  GetPageByPathInput,
  ListChildPagesInput,
  MovePageInput,
  RenamePageInput,
} from './pages.js';

// translations.ts
export {
  createPageTranslation,
  listPageTranslations,
  PageTranslationExistsError,
} from './translations.js';
export type {
  CreatePageTranslationInput,
  ListPageTranslationsInput,
} from './translations.js';

// tree.ts
export {
  BlockNotFoundError,
  CircularMoveError,
  computeBlockDeleteImpact,
  deleteBlock,
  insertBlock,
  moveBlock,
  readBlockTree,
  StaleBlockVersionError,
  updateBlockProps,
} from './tree.js';
export type {
  BlockDeleteImpact,
  DeleteBlockInput,
  InsertBlockInput,
  MoveBlockInput,
  UpdateBlockPropsInput,
} from './tree.js';

// revisions.ts
export {
  computeBlockRestorePreview,
  DegradedRestoreError,
  listBatchRevisions,
  listPageRevisionBatches,
  restoreRevisionBatch,
  RestoreParentNotFoundError,
  RestoreTargetNotFoundError,
  RevisionBatchNotFoundError,
} from './revisions.js';
export type {
  BlockRevisionSummary,
  ComputeBlockRestorePreviewInput,
  ListPageRevisionBatchesInput,
  RestoreBatchPreview,
  RestoreBatchResult,
  RestoreBlockPreview,
  RestorePropertyOutcome,
  RestoreRevisionBatchInput,
  RevisionBatchSummary,
} from './revisions.js';

// publish.ts
export {
  createDraftSnapshot,
  DegradedBlockPublishError,
  publishPage,
  readLatestDraftSnapshot,
  readPublishedSnapshot,
} from './publish.js';
export type {
  CreateDraftSnapshotInput,
  DegradedSnapshotBlock,
  PagePublicationRecord,
  PageSnapshot,
  PublishPageInput,
  SnapshotBlock,
} from './publish.js';

// lifecycle.ts
export {
  AncestorTrashedError,
  computePagePermanentDeleteImpact,
  computePageTrashImpact,
  deletePagePermanently,
  PageScheduleNotInFutureError,
  PageStatusError,
  restorePageFromTrash,
  schedulePage,
  trashPage,
  unpublishPage,
  unschedulePage,
} from './lifecycle.js';
export type {
  DeletePagePermanentlyInput,
  PagePermanentDeleteImpact,
  PageTrashImpact,
  SchedulePageInput,
  TrashPageInput,
  UnpublishPageInput,
  UnschedulePageInput,
} from './lifecycle.js';

// locale.ts
export {
  checkPageLocales,
  computeLocalePurgeImpact,
  LocaleStillEnabledError,
  purgeLocale,
  reportPageLocaleRemoval,
} from './locale.js';
export type {
  ComputeLocalePurgeImpactInput,
  LocalePurgeReport,
  PageLocaleCounts,
  PurgeLocaleInput,
} from './locale.js';

// locks.ts
export {
  acquirePageLock,
  isPageLockLive,
  PAGE_EDIT_LOCK_HEARTBEAT_SECONDS,
  PAGE_EDIT_LOCK_TTL_SECONDS,
  PageLockedError,
  PageLockingDisabledError,
  PageLockNotFoundError,
  PageLockStateChangedError,
  PageLockTakeoverForbiddenError,
  releasePageLock,
  renewPageLock,
  takeOverPageLock,
} from './locks.js';
export type {
  AcquirePageLockInput,
  PageLockGrant,
  PageLockState,
  ReleasePageLockInput,
  RenewPageLockInput,
  TakeOverPageLockInput,
} from './locks.js';
