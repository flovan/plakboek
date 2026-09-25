/**
 * Public barrel for @plakboek/pages, expanded by plan 04-02's tracer.
 * Named re-exports only, grouped by module, values and types in separate
 * statements -- mirrors @plakboek/content's barrel discipline.
 *
 * Deliberately absent, and why: a consumer able to reach any of these could
 * write or read pages/blocks around the audited, version-checked,
 * locale-filtered paths this package guarantees.
 * - `recordBlockRevision` (revisions.ts) -- the block-revision writer,
 *   called only from this package's own tree/publish modules inside an
 *   already-open audited transaction.
 * - `loadPageForUpdate` (pages.ts) -- the row-locking read a structural
 *   write's page-version check builds on; a caller reaching it directly
 *   could lock a page row outside any audited mutation.
 * - `validateBlockProps` (registry.ts) -- called only by this package's own
 *   write paths, immediately before a validated value is persisted.
 * - Every Drizzle schema table (schema.ts) -- a consumer able to read or
 *   write these directly could bypass every guarantee above.
 *
 * Plan 04-13 completes this barrel.
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
  BlockDegradedEvent,
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
export {
  applyBlockConstraints,
  BlockConstraintError,
  constrainBlock,
} from './constraints.js';
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

// versioning.ts
export { upcastOnRead } from './versioning.js';
export type { UpcastResult } from './versioning.js';

// pages.ts
export {
  createPage,
  getPage,
  InvalidPageSlugError,
  LocaleNotEnabledError,
  PageNotFoundError,
  PagePathConflictError,
} from './pages.js';
export type { CreatePageInput } from './pages.js';

// tree.ts
export {
  BlockNotFoundError,
  insertBlock,
  readBlockTree,
  StaleBlockVersionError,
  StalePageVersionError,
  updateBlockProps,
} from './tree.js';
export type { InsertBlockInput, UpdateBlockPropsInput } from './tree.js';

// revisions.ts
export { newRevisionBatchId } from './revisions.js';

// publish.ts
export { buildSnapshotTree, publishPage } from './publish.js';
export type { PagePublicationRecord, PublishPageInput } from './publish.js';

// placement.ts
export {
  assertPlacementAllowed,
  BlockDepthExceededError,
  BlockPlacementError,
  countAncestorSections,
  ROOT_PARENT_SENTINEL,
  SectionNestingDepthExceededError,
  SectionRequiredError,
} from './placement.js';
export type { BlockPlacementReason, PlacementContext } from './placement.js';

// section-lint.ts
export {
  lintSectionProperties,
  reportSectionLint,
  SECTION_LINT_FIELD_TYPES,
  SECTION_LINT_PROPERTY_SUBSTRINGS,
} from './section-lint.js';
export type {
  SectionLintEvent,
  SectionLintFinding,
  SectionLintReason,
} from './section-lint.js';
