/**
 * Public barrel for @plakboek/content, complete as of plan 03-14.
 *
 * Named re-exports only, grouped by module, values and types in separate
 * statements. `tests/unit/public-api.test.ts` holds this surface to one
 * literal list and to the README's Public API tables, so adding or
 * removing an export means changing all three together.
 *
 * Deliberately absent, and why: a consumer able to reach any of these could
 * write or read content around the audited, version-checked, locale-filtered
 * paths this package guarantees.
 *
 * - The field-type registration function (field-types/registry.ts) -- the
 *   only way to add or overwrite a field type's definition at runtime.
 * - The save transaction body and its permission-decision and snapshot
 *   helpers (save.ts) -- meant to be replayed by this package's own modules
 *   (restore, shared-field sync), never called directly.
 * - The unfiltered and row-locking entry reads (entries.ts), and the
 *   working-copy reader built on top of one of them (publish.ts) -- every
 *   host-facing read excludes a removed locale, and these do not.
 * - The `entry_revisions` writer and its cap-pruning sweep (revisions.ts),
 *   called only from this package's own save, publish and revision modules.
 * - The append-only URL-history writer and the transaction-scoped path-
 *   collision checks around it (routing.ts).
 * - The edit-lock write guard every mutation calls internally (locks.ts).
 * - The append-only key-rename history writers (key-history.ts).
 * - The reverse-index writer, the permanent-delete reference-stripper and
 *   their transaction-scoped internals (references.ts).
 * - Transaction-scoped slug generation and availability, and the advisory-
 *   lock key behind them (slug.ts).
 * - The shared counting helpers behind the impact-report functions, not
 *   their own read API (impact-reports.ts).
 * - Every field type's own definition constant -- reachable only through
 *   the field-registry read functions above, never by its own name.
 * - Every Drizzle schema table -- a consumer able to read or write these
 *   directly could bypass every guarantee above.
 */

// config.ts
export {
  defineContentConfig,
  ContentConfigError,
  reportContentWarning,
} from './config.js';
export type {
  ContentConfig,
  ContentConfigIssueCode,
  ContentConfigIssue,
  ContentHooks,
  ContentDeps,
  SeedDriftEvent,
  LocaleRemovedEvent,
} from './config.js';

// types.ts
export { ENTRY_STATUSES, REVISION_MODES } from './types.js';
export type {
  EntryStatus,
  RevisionMode,
  ContentTypeRecord,
  FieldDefinition,
  EntryRecord,
} from './types.js';

// field-types/registry.ts
export {
  FIELD_TYPES,
  isFieldType,
  getFieldTypeDefinition,
  parseFieldOptions,
  UnknownFieldTypeError,
  FieldDefinitionError,
} from './field-types/registry.js';
export type { FieldType, FieldTypeDefinition } from './field-types/registry.js';

// field-types/pattern-safety.ts
export {
  PATTERN_MAX_LENGTH,
  isSafePattern,
} from './field-types/pattern-safety.js';

// field-types/short-text.ts
export { SHORT_TEXT_MAX_LENGTH } from './field-types/short-text.js';

// field-types/long-text.ts
export { LONG_TEXT_MAX_LENGTH } from './field-types/long-text.js';

// field-types/rich-text.ts
export {
  RICH_TEXT_MAX_BYTES,
  RICH_TEXT_MAX_DEPTH,
} from './field-types/rich-text.js';

// field-types/url.ts
export { URL_MAX_LENGTH } from './field-types/url.js';

// field-types/json.ts
export { JSON_FIELD_MAX_BYTES } from './field-types/json.js';

// field-types/select.ts
export { CHOICE_VALUE_PATTERN } from './field-types/select.js';

// field-types/image.ts
export { ASSET_ID_PATTERN } from './field-types/image.js';

// field-types/repeater.ts
export { REPEATER_MAX_ITEMS } from './field-types/repeater.js';

// field-types/options-map.ts (types only)
export type {
  FieldTypeOptionsMap,
  FieldTypeWidgetMap,
} from './field-types/options-map.js';

// validation.ts
export { validateEntryData, FieldValidationError } from './validation.js';
export type {
  FieldValidationIssueCode,
  FieldValidationIssue,
} from './validation.js';

// slug.ts
export {
  normalizeSlug,
  isNormalizedSlug,
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
  SlugConflictError,
  InvalidSlugError,
} from './slug.js';

// url-pattern.ts
export {
  URL_PATTERN_TOKENS,
  URL_PATTERN_MAX_LENGTH,
  UrlPatternError,
  UrlTokenValueError,
  parseUrlPattern,
  resolveUrlPath,
  usesSlugToken,
  usesDateTokens,
} from './url-pattern.js';
export type {
  UrlPatternToken,
  UrlPatternIssueCode,
  UrlPatternIssue,
  ParsedUrlPattern,
  UrlPathInput,
} from './url-pattern.js';

// content-types.ts
export {
  TYPE_KEY_PATTERN,
  LABEL_MAX_LENGTH,
  createContentType,
  getContentTypeByKey,
  ContentTypeValidationError,
  ContentTypeConflictError,
  PendingDraftsError,
  RoutableInUseError,
  ContentTypeHasEntriesError,
  ContentTypeReferencedError,
  TitleFieldError,
  updateContentTypeSettings,
  setContentTypeSlug,
  computeContentTypeKeyRenameImpact,
  renameContentTypeKey,
  setTitleField,
  computeContentTypeDeleteImpact,
  deleteContentType,
} from './content-types.js';
export type {
  CreateContentTypeInput,
  ContentTypeValidationIssueCode,
  ContentTypeValidationIssue,
  TitleFieldErrorReason,
  UpdateContentTypeSettingsInput,
  SetContentTypeSlugInput,
  RenameContentTypeKeyInput,
  SetTitleFieldInput,
  DeleteContentTypeInput,
} from './content-types.js';

// fields.ts
export {
  FIELD_KEY_PATTERN,
  fieldKeyFromLabel,
  FieldKeyConflictError,
  addField,
  computeAddFieldImpact,
  listFields,
  FieldTypeImmutableError,
  computeFieldUpdateImpact,
  updateField,
  computeFieldKeyUsage,
  renameField,
  duplicateField,
  computeFieldDeleteImpact,
  deleteField,
} from './fields.js';
export type {
  AddFieldInput,
  UpdateFieldInput,
  RenameFieldInput,
  DuplicateFieldInput,
  DeleteFieldInput,
} from './fields.js';

// key-history.ts
export { listFieldKeyHistory } from './key-history.js';
export type { FieldKeyHistoryEntry } from './key-history.js';

// impact-reports.ts (types only)
export type {
  ReferencingField,
  ContentTypeDeleteImpact,
  ContentTypeKeyRenameImpact,
  FieldKeyUsage,
  FieldDeleteImpact,
  AddFieldImpact,
  FieldUpdateImpact,
} from './impact-reports.js';

// entries.ts
export {
  createEntry,
  findEntry,
  findTranslations,
  listEntries,
  LocaleNotEnabledError,
  EntryNotFoundError,
} from './entries.js';
export type {
  CreateEntryInput,
  FindEntryInput,
  FindTranslationsInput,
  ListEntriesInput,
} from './entries.js';

// save.ts
export { saveEntry, StaleVersionError } from './save.js';
export type { SaveEntryInput } from './save.js';

// publish.ts
export {
  publishEntry,
  SlugRequiredError,
  EntryStateChangedError,
} from './publish.js';
export type { PublishEntryInput } from './publish.js';

// routing.ts
export {
  computeEntryPath,
  computeUrlPatternChangeImpact,
  setUrlPattern,
  UrlPatternRequiredError,
  UrlCollisionError,
  UrlPatternInUseError,
  UrlPatternCollisionError,
} from './routing.js';
export type {
  ComputeEntryPathContentType,
  UrlPatternCollision,
  ComputeUrlPatternChangeImpactInput,
  UrlPatternChangeImpact,
  SetUrlPatternInput,
  SetUrlPatternResult,
} from './routing.js';

// lifecycle.ts
export {
  unpublishEntry,
  scheduleEntry,
  unscheduleEntry,
  trashEntry,
  computeEntryTrashImpact,
  restoreEntryFromTrash,
  computeEntryPermanentDeleteImpact,
  deleteEntryPermanently,
  EntryStatusError,
  ScheduleNotInFutureError,
} from './lifecycle.js';
export type {
  UnpublishEntryInput,
  ScheduleEntryInput,
  UnscheduleEntryInput,
  TrashEntryInput,
  EntryTrashImpact,
  ComputeEntryTrashImpactInput,
  RestoreEntryFromTrashInput,
  EntryPermanentDeleteImpact,
  ComputeEntryPermanentDeleteImpactInput,
  DeleteEntryPermanentlyInput,
} from './lifecycle.js';

// locks.ts
export {
  EDIT_LOCK_HEARTBEAT_SECONDS,
  EDIT_LOCK_TTL_SECONDS,
  isLockLive,
  acquireEditLock,
  renewEditLock,
  releaseEditLock,
  takeOverEditLock,
  EntryLockedError,
  EditLockingDisabledError,
  LockTakeoverForbiddenError,
  LockStateChangedError,
} from './locks.js';
export type {
  AcquireEditLockInput,
  EditLockGrant,
  RenewEditLockInput,
  ReleaseEditLockInput,
  TakeOverEditLockInput,
} from './locks.js';

// revisions.ts
export {
  listRevisions,
  computeRestorePreview,
  restoreRevision,
  RevisionNotFoundError,
} from './revisions.js';
export type {
  RevisionKind,
  RevisionSummary,
  ListRevisionsInput,
  RestorePreview,
  ComputeRestorePreviewInput,
  RestoreRevisionInput,
} from './revisions.js';

// settings.ts
export {
  getRevisionCap,
  computeRevisionCapImpact,
  setRevisionCap,
  RevisionCapError,
} from './settings.js';
export type {
  RevisionCapImpact,
  SetRevisionCapInput,
  SetRevisionCapResult,
} from './settings.js';

// translations.ts
export { createTranslation, TranslationExistsError } from './translations.js';
export type { CreateTranslationInput } from './translations.js';

// field-translatable.ts
export {
  computeTranslatableChangeImpact,
  setFieldTranslatable,
} from './field-translatable.js';
export type {
  TranslatableChangeImpactGroup,
  TranslatableChangeImpact,
  SetFieldTranslatableInput,
} from './field-translatable.js';

// singletons.ts
export {
  getOrCreateSingleton,
  findSingleton,
  listSingletonRecords,
  SingletonEntryError,
} from './singletons.js';
export type {
  SingletonEntryErrorReason,
  GetOrCreateSingletonInput,
  FindSingletonInput,
  ListSingletonRecordsInput,
} from './singletons.js';

// locales.ts
export { checkContentLocales } from './locales.js';
export type { LocaleCheckReport } from './locales.js';

// seo.ts
export {
  ENTRY_SEO_PROPERTIES,
  EMPTY_ENTRY_SEO,
  normalizeEntrySeo,
  validateEntrySeo,
  EntrySeoValidationError,
  SEO_TITLE_MAX_LENGTH,
  SEO_DESCRIPTION_MAX_LENGTH,
  SEO_CANONICAL_MAX_LENGTH,
} from './seo.js';
export type {
  EntrySeoProperty,
  EntrySeo,
  EntrySeoIssueCode,
  EntrySeoIssue,
} from './seo.js';

// seed.ts
export {
  defineContentTypes,
  applySeed,
  ContentTypeSeedError,
  SEED_ID_PATTERN,
} from './seed.js';
export type {
  SeedIssue,
  SeedIssueCode,
  SeedContentTypeInput,
  SeedFieldInput,
  DefinedContentTypeSeed,
  SeedApplicationReport,
} from './seed.js';

// references.ts
export {
  computeEntryReferenceUsage,
  ReferenceTargetMissingError,
  ReferenceTypeNotAllowedError,
} from './references.js';
export type {
  EntryReferenceUsageEntry,
  EntryReferenceUsage,
  ComputeEntryReferenceUsageInput,
} from './references.js';
