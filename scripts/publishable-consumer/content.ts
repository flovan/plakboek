import {
  acquireEditLock,
  type AcquireEditLockInput,
  addField,
  type AddFieldImpact,
  type AddFieldInput,
  applySeed,
  ASSET_ID_PATTERN,
  checkContentLocales,
  CHOICE_VALUE_PATTERN,
  computeAddFieldImpact,
  computeContentTypeDeleteImpact,
  computeContentTypeKeyRenameImpact,
  computeEntryPath,
  type ComputeEntryPathContentType,
  computeEntryPermanentDeleteImpact,
  type ComputeEntryPermanentDeleteImpactInput,
  computeEntryReferenceUsage,
  type ComputeEntryReferenceUsageInput,
  computeEntryTrashImpact,
  type ComputeEntryTrashImpactInput,
  computeFieldDeleteImpact,
  computeFieldKeyUsage,
  computeFieldUpdateImpact,
  computeRestorePreview,
  type ComputeRestorePreviewInput,
  computeRevisionCapImpact,
  computeTranslatableChangeImpact,
  computeUrlPatternChangeImpact,
  type ComputeUrlPatternChangeImpactInput,
  type ContentConfig,
  ContentConfigError,
  type ContentConfigIssue,
  type ContentConfigIssueCode,
  type ContentDeps,
  type ContentHooks,
  ContentTypeConflictError,
  type ContentTypeDeleteImpact,
  ContentTypeHasEntriesError,
  type ContentTypeKeyRenameImpact,
  type ContentTypeRecord,
  ContentTypeReferencedError,
  ContentTypeSeedError,
  ContentTypeValidationError,
  type ContentTypeValidationIssue,
  type ContentTypeValidationIssueCode,
  createContentType,
  type CreateContentTypeInput,
  createEntry,
  type CreateEntryInput,
  createTranslation,
  type CreateTranslationInput,
  defineContentConfig,
  defineContentTypes,
  type DefinedContentTypeSeed,
  deleteContentType,
  type DeleteContentTypeInput,
  deleteEntryPermanently,
  type DeleteEntryPermanentlyInput,
  deleteField,
  type DeleteFieldInput,
  duplicateField,
  type DuplicateFieldInput,
  EDIT_LOCK_HEARTBEAT_SECONDS,
  EDIT_LOCK_TTL_SECONDS,
  type EditLockGrant,
  EditLockingDisabledError,
  EMPTY_ENTRY_SEO,
  ENTRY_SEO_PROPERTIES,
  ENTRY_STATUSES,
  EntryLockedError,
  EntryNotFoundError,
  type EntryPermanentDeleteImpact,
  type EntryRecord,
  type EntryReferenceUsage,
  type EntryReferenceUsageEntry,
  type EntrySeo,
  type EntrySeoIssue,
  type EntrySeoIssueCode,
  type EntrySeoProperty,
  EntrySeoValidationError,
  EntryStateChangedError,
  type EntryStatus,
  EntryStatusError,
  type EntryTrashImpact,
  FIELD_KEY_PATTERN,
  FIELD_TYPES,
  type FieldDefinition,
  FieldDefinitionError,
  type FieldDeleteImpact,
  FieldKeyConflictError,
  fieldKeyFromLabel,
  type FieldKeyHistoryEntry,
  type FieldKeyUsage,
  type FieldType,
  type FieldTypeDefinition,
  FieldTypeImmutableError,
  type FieldTypeOptionsMap,
  type FieldTypeWidgetMap,
  type FieldUpdateImpact,
  FieldValidationError,
  type FieldValidationIssue,
  type FieldValidationIssueCode,
  findEntry,
  type FindEntryInput,
  findSingleton,
  type FindSingletonInput,
  findTranslations,
  type FindTranslationsInput,
  getContentTypeByKey,
  getFieldTypeDefinition,
  getOrCreateSingleton,
  type GetOrCreateSingletonInput,
  getRevisionCap,
  InvalidSlugError,
  isFieldType,
  isLockLive,
  isNormalizedSlug,
  isSafePattern,
  JSON_FIELD_MAX_BYTES,
  LABEL_MAX_LENGTH,
  listEntries,
  type ListEntriesInput,
  listFieldKeyHistory,
  listFields,
  listRevisions,
  type ListRevisionsInput,
  listSingletonRecords,
  type ListSingletonRecordsInput,
  type LocaleCheckReport,
  LocaleNotEnabledError,
  type LocaleRemovedEvent,
  LockStateChangedError,
  LockTakeoverForbiddenError,
  LONG_TEXT_MAX_LENGTH,
  normalizeEntrySeo,
  normalizeSlug,
  type ParsedUrlPattern,
  parseFieldOptions,
  parseUrlPattern,
  PATTERN_MAX_LENGTH,
  PendingDraftsError,
  publishEntry,
  type PublishEntryInput,
  ReferenceTargetMissingError,
  ReferenceTypeNotAllowedError,
  type ReferencingField,
  releaseEditLock,
  type ReleaseEditLockInput,
  renameContentTypeKey,
  type RenameContentTypeKeyInput,
  renameField,
  type RenameFieldInput,
  renewEditLock,
  type RenewEditLockInput,
  REPEATER_MAX_ITEMS,
  reportContentWarning,
  resolveUrlPath,
  restoreEntryFromTrash,
  type RestoreEntryFromTrashInput,
  type RestorePreview,
  restoreRevision,
  type RestoreRevisionInput,
  REVISION_MODES,
  RevisionCapError,
  type RevisionCapImpact,
  type RevisionKind,
  type RevisionMode,
  RevisionNotFoundError,
  type RevisionSummary,
  RICH_TEXT_MAX_BYTES,
  RICH_TEXT_MAX_DEPTH,
  RoutableInUseError,
  saveEntry,
  type SaveEntryInput,
  scheduleEntry,
  type ScheduleEntryInput,
  ScheduleNotInFutureError,
  SEED_ID_PATTERN,
  type SeedApplicationReport,
  type SeedContentTypeInput,
  type SeedDriftEvent,
  type SeedFieldInput,
  type SeedIssue,
  type SeedIssueCode,
  SEO_CANONICAL_MAX_LENGTH,
  SEO_DESCRIPTION_MAX_LENGTH,
  SEO_TITLE_MAX_LENGTH,
  setContentTypeSlug,
  type SetContentTypeSlugInput,
  setFieldTranslatable,
  type SetFieldTranslatableInput,
  setRevisionCap,
  type SetRevisionCapInput,
  type SetRevisionCapResult,
  setTitleField,
  type SetTitleFieldInput,
  setUrlPattern,
  type SetUrlPatternInput,
  type SetUrlPatternResult,
  SHORT_TEXT_MAX_LENGTH,
  SingletonEntryError,
  type SingletonEntryErrorReason,
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
  SlugConflictError,
  SlugRequiredError,
  StaleVersionError,
  takeOverEditLock,
  type TakeOverEditLockInput,
  TitleFieldError,
  type TitleFieldErrorReason,
  type TranslatableChangeImpact,
  type TranslatableChangeImpactGroup,
  TranslationExistsError,
  trashEntry,
  type TrashEntryInput,
  TYPE_KEY_PATTERN,
  UnknownFieldTypeError,
  unpublishEntry,
  type UnpublishEntryInput,
  unscheduleEntry,
  type UnscheduleEntryInput,
  updateContentTypeSettings,
  type UpdateContentTypeSettingsInput,
  updateField,
  type UpdateFieldInput,
  URL_MAX_LENGTH,
  URL_PATTERN_MAX_LENGTH,
  URL_PATTERN_TOKENS,
  UrlCollisionError,
  type UrlPathInput,
  type UrlPatternChangeImpact,
  type UrlPatternCollision,
  UrlPatternCollisionError,
  UrlPatternError,
  UrlPatternInUseError,
  type UrlPatternIssue,
  type UrlPatternIssueCode,
  UrlPatternRequiredError,
  type UrlPatternToken,
  UrlTokenValueError,
  usesDateTokens,
  usesSlugToken,
  validateEntryData,
  validateEntrySeo,
} from '@plakboek/content';
import * as content from '@plakboek/content';

// Runtime kind checks. Nothing below opens a connection or applies a
// migration: the only calls made are the pure ones listed further down.

const functions: Record<string, unknown> = {
  acquireEditLock,
  addField,
  applySeed,
  checkContentLocales,
  computeAddFieldImpact,
  computeContentTypeDeleteImpact,
  computeContentTypeKeyRenameImpact,
  computeEntryPath,
  computeEntryPermanentDeleteImpact,
  computeEntryReferenceUsage,
  computeEntryTrashImpact,
  computeFieldDeleteImpact,
  computeFieldKeyUsage,
  computeFieldUpdateImpact,
  computeRestorePreview,
  computeRevisionCapImpact,
  computeTranslatableChangeImpact,
  computeUrlPatternChangeImpact,
  createContentType,
  createEntry,
  createTranslation,
  defineContentConfig,
  defineContentTypes,
  deleteContentType,
  deleteEntryPermanently,
  deleteField,
  duplicateField,
  findEntry,
  findSingleton,
  findTranslations,
  fieldKeyFromLabel,
  getContentTypeByKey,
  getFieldTypeDefinition,
  getOrCreateSingleton,
  getRevisionCap,
  isFieldType,
  isLockLive,
  isNormalizedSlug,
  isSafePattern,
  listEntries,
  listFieldKeyHistory,
  listFields,
  listRevisions,
  listSingletonRecords,
  normalizeEntrySeo,
  normalizeSlug,
  parseFieldOptions,
  parseUrlPattern,
  publishEntry,
  releaseEditLock,
  renameContentTypeKey,
  renameField,
  renewEditLock,
  reportContentWarning,
  resolveUrlPath,
  restoreEntryFromTrash,
  restoreRevision,
  saveEntry,
  scheduleEntry,
  setContentTypeSlug,
  setFieldTranslatable,
  setRevisionCap,
  setTitleField,
  setUrlPattern,
  takeOverEditLock,
  trashEntry,
  unpublishEntry,
  unscheduleEntry,
  updateContentTypeSettings,
  updateField,
  usesDateTokens,
  usesSlugToken,
  validateEntryData,
  validateEntrySeo,
};

const errorClasses: Record<string, unknown> = {
  ContentConfigError,
  ContentTypeConflictError,
  ContentTypeHasEntriesError,
  ContentTypeReferencedError,
  ContentTypeSeedError,
  ContentTypeValidationError,
  EditLockingDisabledError,
  EntryLockedError,
  EntryNotFoundError,
  EntrySeoValidationError,
  EntryStateChangedError,
  EntryStatusError,
  FieldDefinitionError,
  FieldKeyConflictError,
  FieldTypeImmutableError,
  FieldValidationError,
  InvalidSlugError,
  LocaleNotEnabledError,
  LockStateChangedError,
  LockTakeoverForbiddenError,
  PendingDraftsError,
  ReferenceTargetMissingError,
  ReferenceTypeNotAllowedError,
  RevisionCapError,
  RevisionNotFoundError,
  RoutableInUseError,
  ScheduleNotInFutureError,
  SingletonEntryError,
  SlugConflictError,
  SlugRequiredError,
  StaleVersionError,
  TitleFieldError,
  TranslationExistsError,
  UnknownFieldTypeError,
  UrlCollisionError,
  UrlPatternCollisionError,
  UrlPatternError,
  UrlPatternInUseError,
  UrlPatternRequiredError,
  UrlTokenValueError,
};

const numbers: Record<string, unknown> = {
  EDIT_LOCK_HEARTBEAT_SECONDS,
  EDIT_LOCK_TTL_SECONDS,
  JSON_FIELD_MAX_BYTES,
  LABEL_MAX_LENGTH,
  LONG_TEXT_MAX_LENGTH,
  PATTERN_MAX_LENGTH,
  REPEATER_MAX_ITEMS,
  RICH_TEXT_MAX_BYTES,
  RICH_TEXT_MAX_DEPTH,
  SEO_CANONICAL_MAX_LENGTH,
  SEO_DESCRIPTION_MAX_LENGTH,
  SEO_TITLE_MAX_LENGTH,
  SHORT_TEXT_MAX_LENGTH,
  SLUG_MAX_LENGTH,
  URL_MAX_LENGTH,
  URL_PATTERN_MAX_LENGTH,
};

const regexPatterns: Record<string, unknown> = {
  ASSET_ID_PATTERN,
  CHOICE_VALUE_PATTERN,
  FIELD_KEY_PATTERN,
  SEED_ID_PATTERN,
  SLUG_PATTERN,
  TYPE_KEY_PATTERN,
};

const frozenArrays: Record<string, unknown> = {
  ENTRY_SEO_PROPERTIES,
  ENTRY_STATUSES,
  FIELD_TYPES,
  REVISION_MODES,
  URL_PATTERN_TOKENS,
};

const frozenObjects: Record<string, unknown> = {
  EMPTY_ENTRY_SEO,
};

function fail(reason: string): never {
  console.error(`content.ts: ${reason}`);
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

for (const [name, value] of Object.entries(frozenArrays)) {
  if (!Array.isArray(value) || value.length === 0 || !Object.isFrozen(value)) {
    fail(`${name} is not a non-empty frozen array`);
  }
}

for (const [name, value] of Object.entries(frozenObjects)) {
  if (typeof value !== 'object' || value === null || !Object.isFrozen(value)) {
    fail(`${name} is not a frozen object`);
  }
}

const documentedValueCount =
  Object.keys(functions).length +
  Object.keys(errorClasses).length +
  Object.keys(numbers).length +
  Object.keys(regexPatterns).length +
  Object.keys(frozenArrays).length +
  Object.keys(frozenObjects).length;

const exportedNames = Object.keys(content);
if (exportedNames.length !== documentedValueCount) {
  fail(
    `the entry point exports ${exportedNames.length} values, the probe knows ${documentedValueCount}`,
  );
}

// Every transaction-level writer, unfiltered read, the field-type
// registration function, every field type's own definition constant and a
// representative sample of the schema tables must stay unreachable.
const reachable: Record<string, unknown> = content;
for (const internal of [
  'registerFieldType',
  'saveEntryInTransaction',
  'decideSavePermission',
  'applySyncedFieldChanges',
  'entrySnapshot',
  'getEntry',
  'loadEntryForUpdate',
  'lockTranslationGroupForUpdate',
  'toEntryRecord',
  'readWorkingCopy',
  'recordRevision',
  'pruneSaveRevisions',
  'recordUrlHistory',
  'assertPathAvailable',
  'urlCollisionFromUniqueViolation',
  'assertRowsWritable',
  'recordContentTypeKeyChange',
  'recordFieldKeyChange',
  'countEntries',
  'countEntriesHoldingKey',
  'syncEntryReferenceIndex',
  'stripTranslationGroupFromReferences',
  'assertReferencesResolvable',
  'collectReferenceValues',
  'removeTranslationGroupFromEntryData',
  'generateUniqueEntrySlug',
  'assertEntrySlugAvailable',
  'slugConflictFromUniqueViolation',
  'shortTextFieldType',
  'contentTypes',
  'contentTypeFields',
  'contentEntries',
  'entryRevisions',
]) {
  if (reachable[internal] !== undefined) {
    fail(`${internal} must not be reachable from the entry point`);
  }
}

// Pure calls: no connection is opened and no migration is applied.

const config: ContentConfig = defineContentConfig({
  locales: ['en', 'nl'],
  defaultLocale: 'en',
  timezone: 'Europe/Brussels',
});
if (!Object.isFrozen(config) || !Object.isFrozen(config.locales)) {
  fail('defineContentConfig did not return a frozen config');
}

const seedField: SeedFieldInput = {
  seedId: 'article-title',
  label: 'Title',
  fieldType: 'short_text',
};
const seedType: SeedContentTypeInput = {
  seedId: 'article-type',
  key: 'article',
  labelSingular: 'Article',
  labelPlural: 'Articles',
  fields: [seedField],
};
const definedSeed: DefinedContentTypeSeed = defineContentTypes([seedType]);
if (!Object.isFrozen(definedSeed)) {
  fail('defineContentTypes did not return a frozen result');
}

const seoDefaults: EntrySeo = normalizeEntrySeo(null);
if (JSON.stringify(seoDefaults) !== JSON.stringify(EMPTY_ENTRY_SEO)) {
  fail('normalizeEntrySeo(null) did not equal the documented defaults');
}
const validatedSeo: EntrySeo = validateEntrySeo(
  { title: 'A title' },
  { seoEnabled: true },
);
if (validatedSeo.title !== 'A title') {
  fail('validateEntrySeo did not accept a title on an SEO-enabled type');
}

if (normalizeSlug('Café Déjà Vu') !== 'cafe-deja-vu') {
  fail('normalizeSlug did not return the ASCII slug of an accented label');
}

if (fieldKeyFromLabel('Meta Title') !== 'metaTitle') {
  fail('fieldKeyFromLabel did not return camelCase for a two-word label');
}

if (!isFieldType('short_text') || isFieldType('not_a_real_field_type')) {
  fail('isFieldType did not distinguish a real field type from a made-up one');
}

const shortTextDefinition: FieldTypeDefinition =
  getFieldTypeDefinition('short_text');
if (!shortTextDefinition.widgets.includes(shortTextDefinition.defaultWidget)) {
  fail("a registered field type's defaultWidget is not in its own widgets");
}

const parsedPattern: ParsedUrlPattern = parseUrlPattern('/blog/{slug}');
const urlPathInput: UrlPathInput = {
  slug: 'hello-world',
  publicId: 1,
  firstPublishedAt: null,
};
const resolvedPath = resolveUrlPath(parsedPattern, urlPathInput, 'UTC');
if (resolvedPath !== '/blog/hello-world') {
  fail('parseUrlPattern/resolveUrlPath did not render the expected path');
}

const titleField: FieldDefinition = {
  id: 'field-id',
  contentTypeId: 'ct-id',
  key: 'title',
  label: 'Title',
  fieldType: 'short_text',
  translatable: true,
  required: true,
  options: {},
  widget: 'text',
  widgetOptions: {},
  defaultValue: null,
  sortOrder: 0,
};
const validatedData = validateEntryData([titleField], { title: 'Hello' });
if (validatedData['title'] !== 'Hello') {
  fail('validateEntryData did not return the validated object');
}

// Type proofs: one declaration per exported type not already bound above,
// so the packed declarations must resolve every name for this file to
// type-check. Nothing here is ever called or awaited.

const contentConfigIssueCode: ContentConfigIssueCode = 'NO_LOCALES';
const contentConfigIssue: ContentConfigIssue = {
  code: 'NO_LOCALES',
  message: 'no locales configured',
};
const contentHooks: ContentHooks = {};
const seedDriftEvent: SeedDriftEvent = {
  seedId: 'article-type',
  kind: 'type',
  property: 'labelSingular',
  seededValue: 'Article',
  storedValue: 'Post',
  occurredAt: new Date(0),
};
const localeRemovedEvent: LocaleRemovedEvent = {
  locale: 'de',
  entryCount: 0,
  occurredAt: new Date(0),
};
const entryStatus: EntryStatus = 'draft';
const revisionMode: RevisionMode = 'on_publish';
const contentTypeRecord: ContentTypeRecord = {
  id: 'ct-id',
  key: 'article',
  slug: 'articles',
  labelSingular: 'Article',
  labelPlural: 'Articles',
  description: null,
  routable: true,
  urlPattern: null,
  singleton: false,
  drafts: false,
  revisions: false,
  revisionMode: null,
  editLocking: false,
  seo: false,
  titleFieldKey: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const entryRecord: EntryRecord = {
  id: 'entry-id',
  contentTypeId: 'ct-id',
  translationGroup: 'group-id',
  publicId: 1,
  locale: 'en',
  slug: null,
  status: 'draft',
  data: {},
  seo: null,
  version: 1,
  draftRevisionId: null,
  liveRevisionId: null,
  resolvedPath: null,
  lockedBy: null,
  lockedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  publishedAt: null,
  firstPublishedAt: null,
  scheduledAt: null,
  trashedAt: null,
};
const fieldType: FieldType = 'short_text';
const fieldValidationIssueCode: FieldValidationIssueCode = 'REQUIRED';
const fieldValidationIssue: FieldValidationIssue = {
  code: 'REQUIRED',
  fieldKey: 'title',
  path: ['title'],
  message: 'is required',
};
const urlPatternToken: UrlPatternToken = 'slug';
const urlPatternIssueCode: UrlPatternIssueCode = 'EMPTY';
const urlPatternIssue: UrlPatternIssue = {
  code: 'EMPTY',
  message: 'pattern is empty',
};
const createContentTypeInput: CreateContentTypeInput = {
  key: 'article',
  labelSingular: 'Article',
  labelPlural: 'Articles',
};
const contentTypeValidationIssueCode: ContentTypeValidationIssueCode =
  'INVALID_KEY';
const contentTypeValidationIssue: ContentTypeValidationIssue = {
  code: 'INVALID_KEY',
  message: 'invalid key',
};
const titleFieldErrorReason: TitleFieldErrorReason = 'NOT_ROUTABLE';
const updateContentTypeSettingsInput: UpdateContentTypeSettingsInput = {
  key: 'article',
};
const setContentTypeSlugInput: SetContentTypeSlugInput = {
  key: 'article',
  slug: 'articles',
};
const renameContentTypeKeyInput: RenameContentTypeKeyInput = {
  key: 'article',
  newKey: 'post',
};
const setTitleFieldInput: SetTitleFieldInput = {
  key: 'article',
  fieldKey: 'title',
};
const deleteContentTypeInput: DeleteContentTypeInput = { key: 'article' };
const addFieldInput: AddFieldInput = {
  contentTypeKey: 'article',
  label: 'Title',
  fieldType: 'short_text',
};
const updateFieldInput: UpdateFieldInput = {
  contentTypeKey: 'article',
  fieldKey: 'title',
};
const renameFieldInput: RenameFieldInput = {
  contentTypeKey: 'article',
  fieldKey: 'title',
  newKey: 'headline',
};
const duplicateFieldInput: DuplicateFieldInput = {
  contentTypeKey: 'article',
  fieldKey: 'title',
};
const deleteFieldInput: DeleteFieldInput = {
  contentTypeKey: 'article',
  fieldKey: 'title',
};
const fieldKeyHistoryEntry: FieldKeyHistoryEntry = {
  id: 1,
  contentTypeId: 'ct-id',
  fieldId: 'field-id',
  oldKey: null,
  newKey: 'title',
  changedBy: null,
  changedAt: new Date(0),
};
const referencingField: ReferencingField = {
  contentTypeKey: 'article',
  fieldKey: 'author',
  path: 'author',
};
const contentTypeDeleteImpact: ContentTypeDeleteImpact = {
  entryCount: 0,
  referencingFields: [],
};
const contentTypeKeyRenameImpact: ContentTypeKeyRenameImpact = {
  entryCount: 0,
  referencingFields: [],
  bindingsUsingKey: 0,
};
const fieldKeyUsage: FieldKeyUsage = {
  entriesHoldingValue: 0,
  bindingsUsingKey: 0,
  suggestDuplicate: false,
};
const fieldDeleteImpact: FieldDeleteImpact = {
  entriesHoldingValue: 0,
  clearsTitleField: false,
  bindingsUsingKey: 0,
};
const addFieldImpact: AddFieldImpact = {
  entryCount: 0,
  entriesToBackfill: 0,
  entriesBlockedUntilFilled: 0,
};
const fieldUpdateImpact: FieldUpdateImpact = {
  entriesFailingNewRules: 0,
  entriesToBackfill: 0,
  repeaterItemsLosingValues: 0,
};
const createEntryInput: CreateEntryInput = {
  contentTypeKey: 'article',
  locale: 'en',
};
const findEntryInput: FindEntryInput = { entryId: 'entry-id' };
const findTranslationsInput: FindTranslationsInput = {
  translationGroup: 'group-id',
};
const listEntriesInput: ListEntriesInput = {
  contentTypeKey: 'article',
  locale: 'en',
};
const saveEntryInput: SaveEntryInput = {
  entryId: 'entry-id',
  baseVersion: 1,
  data: {},
};
const publishEntryInput: PublishEntryInput = {
  entryId: 'entry-id',
  baseVersion: 1,
};
const computeEntryPathContentType: ComputeEntryPathContentType = {
  id: 'ct-id',
  routable: true,
  urlPattern: null,
};
const urlPatternCollision: UrlPatternCollision = {
  locale: 'en',
  path: '/a',
  entryIds: [],
};
const computeUrlPatternChangeImpactInput: ComputeUrlPatternChangeImpactInput = {
  contentTypeKey: 'article',
  urlPattern: null,
};
const urlPatternChangeImpact: UrlPatternChangeImpact = {
  publishedEntries: 0,
  changedPaths: 0,
  collisions: [],
};
const setUrlPatternInput: SetUrlPatternInput = {
  contentTypeKey: 'article',
  urlPattern: null,
};
const setUrlPatternResult: SetUrlPatternResult = {
  contentTypeId: 'ct-id',
  urlPattern: null,
  changedPaths: 0,
};
const unpublishEntryInput: UnpublishEntryInput = {
  entryId: 'entry-id',
  baseVersion: 1,
};
const scheduleEntryInput: ScheduleEntryInput = {
  entryId: 'entry-id',
  baseVersion: 1,
  scheduledAt: new Date(0),
};
const unscheduleEntryInput: UnscheduleEntryInput = {
  entryId: 'entry-id',
  baseVersion: 1,
};
const trashEntryInput: TrashEntryInput = {
  entryId: 'entry-id',
  baseVersion: 1,
};
const entryTrashImpact: EntryTrashImpact = {
  status: 'draft',
  referencedBy: 0,
  referencingEntries: [],
};
const computeEntryTrashImpactInput: ComputeEntryTrashImpactInput = {
  entryId: 'entry-id',
};
const restoreEntryFromTrashInput: RestoreEntryFromTrashInput = {
  entryId: 'entry-id',
  baseVersion: 1,
};
const entryPermanentDeleteImpact: EntryPermanentDeleteImpact = {
  isLastRowOfGroup: false,
  referencedBy: 0,
  referencingEntries: [],
  entriesBlockedUntilRefilled: [],
};
const computeEntryPermanentDeleteImpactInput: ComputeEntryPermanentDeleteImpactInput =
  { entryId: 'entry-id' };
const deleteEntryPermanentlyInput: DeleteEntryPermanentlyInput = {
  entryId: 'entry-id',
  baseVersion: 1,
};
const acquireEditLockInput: AcquireEditLockInput = { entryId: 'entry-id' };
const editLockGrant: EditLockGrant = {
  lockedAt: new Date(0),
  expiresAt: new Date(0),
};
const renewEditLockInput: RenewEditLockInput = { entryId: 'entry-id' };
const releaseEditLockInput: ReleaseEditLockInput = { entryId: 'entry-id' };
const takeOverEditLockInput: TakeOverEditLockInput = { entryId: 'entry-id' };
const revisionKind: RevisionKind = 'save';
const revisionSummary: RevisionSummary = {
  id: 'rev-id',
  kind: 'save',
  createdAt: new Date(0),
  authorId: null,
};
const listRevisionsInput: ListRevisionsInput = { entryId: 'entry-id' };
const restorePreview: RestorePreview = {
  revisionId: 'rev-id',
  mappedKeys: [],
  droppedKeys: [],
  emptyFields: [],
  data: {},
  validationIssues: [],
};
const computeRestorePreviewInput: ComputeRestorePreviewInput = {
  entryId: 'entry-id',
  revisionId: 'rev-id',
};
const restoreRevisionInput: RestoreRevisionInput = {
  entryId: 'entry-id',
  baseVersion: 1,
  revisionId: 'rev-id',
};
const revisionCapImpact: RevisionCapImpact = {
  entriesAffected: 0,
  revisionsToPrune: 0,
};
const setRevisionCapInput: SetRevisionCapInput = { cap: 10 };
const setRevisionCapResult: SetRevisionCapResult = { cap: 10, pruned: 0 };
const createTranslationInput: CreateTranslationInput = {
  sourceEntryId: 'entry-id',
  locale: 'nl',
};
const translatableChangeImpactGroup: TranslatableChangeImpactGroup = {
  translationGroup: 'group-id',
  winnerLocale: 'en',
  differingLocales: [],
};
const translatableChangeImpact: TranslatableChangeImpact = {
  groupsAffected: 0,
  groups: [],
};
const setFieldTranslatableInput: SetFieldTranslatableInput = {
  contentTypeKey: 'article',
  fieldKey: 'title',
  translatable: false,
};
const singletonEntryErrorReason: SingletonEntryErrorReason = 'not-singleton';
const getOrCreateSingletonInput: GetOrCreateSingletonInput = {
  contentTypeKey: 'site-settings',
  locale: 'en',
};
const findSingletonInput: FindSingletonInput = {
  contentTypeKey: 'site-settings',
  locale: 'en',
};
const listSingletonRecordsInput: ListSingletonRecordsInput = {
  contentTypeKey: 'site-settings',
};
const localeCheckReport: LocaleCheckReport = { removedLocales: [] };
const entrySeoProperty: EntrySeoProperty = 'title';
const entrySeoIssueCode: EntrySeoIssueCode = 'SEO_NOT_ENABLED';
const entrySeoIssue: EntrySeoIssue = {
  code: 'SEO_NOT_ENABLED',
  property: null,
  message: 'seo not enabled',
};
const seedIssue: SeedIssue = {
  code: 'INVALID_SEED_CONFIG',
  seedId: null,
  message: 'invalid seed',
};
const seedIssueCode: SeedIssueCode = 'INVALID_SEED_CONFIG';
const seedApplicationReport: SeedApplicationReport = {
  createdTypes: [],
  createdFields: [],
  adopted: [],
  skipped: [],
  drift: [],
};
const entryReferenceUsageEntry: EntryReferenceUsageEntry = {
  entryId: 'entry-id',
  contentTypeKey: 'article',
  locale: 'en',
  fieldKey: 'author',
  required: false,
};
const entryReferenceUsage: EntryReferenceUsage = {
  referencedBy: 0,
  referencingEntries: [],
};
const computeEntryReferenceUsageInput: ComputeEntryReferenceUsageInput = {
  translationGroup: 'group-id',
};

// Types that describe a live handle (the deps bundle) or a compile-time-only
// mapped type spanning every field type (which no code path constructs as a
// literal) are proven as parameter types of a function that is never called.
function neverCalled(
  _deps: ContentDeps,
  _optionsMap: FieldTypeOptionsMap,
  _widgetMap: FieldTypeWidgetMap,
): number {
  return 1;
}

const typeProofs: unknown[] = [
  contentConfigIssueCode,
  contentConfigIssue,
  contentHooks,
  seedDriftEvent,
  localeRemovedEvent,
  entryStatus,
  revisionMode,
  contentTypeRecord,
  entryRecord,
  fieldType,
  fieldValidationIssueCode,
  fieldValidationIssue,
  urlPatternToken,
  urlPatternIssueCode,
  urlPatternIssue,
  createContentTypeInput,
  contentTypeValidationIssueCode,
  contentTypeValidationIssue,
  titleFieldErrorReason,
  updateContentTypeSettingsInput,
  setContentTypeSlugInput,
  renameContentTypeKeyInput,
  setTitleFieldInput,
  deleteContentTypeInput,
  addFieldInput,
  updateFieldInput,
  renameFieldInput,
  duplicateFieldInput,
  deleteFieldInput,
  fieldKeyHistoryEntry,
  referencingField,
  contentTypeDeleteImpact,
  contentTypeKeyRenameImpact,
  fieldKeyUsage,
  fieldDeleteImpact,
  addFieldImpact,
  fieldUpdateImpact,
  createEntryInput,
  findEntryInput,
  findTranslationsInput,
  listEntriesInput,
  saveEntryInput,
  publishEntryInput,
  computeEntryPathContentType,
  urlPatternCollision,
  computeUrlPatternChangeImpactInput,
  urlPatternChangeImpact,
  setUrlPatternInput,
  setUrlPatternResult,
  unpublishEntryInput,
  scheduleEntryInput,
  unscheduleEntryInput,
  trashEntryInput,
  entryTrashImpact,
  computeEntryTrashImpactInput,
  restoreEntryFromTrashInput,
  entryPermanentDeleteImpact,
  computeEntryPermanentDeleteImpactInput,
  deleteEntryPermanentlyInput,
  acquireEditLockInput,
  editLockGrant,
  renewEditLockInput,
  releaseEditLockInput,
  takeOverEditLockInput,
  revisionKind,
  revisionSummary,
  listRevisionsInput,
  restorePreview,
  computeRestorePreviewInput,
  restoreRevisionInput,
  revisionCapImpact,
  setRevisionCapInput,
  setRevisionCapResult,
  createTranslationInput,
  translatableChangeImpactGroup,
  translatableChangeImpact,
  setFieldTranslatableInput,
  singletonEntryErrorReason,
  getOrCreateSingletonInput,
  findSingletonInput,
  listSingletonRecordsInput,
  localeCheckReport,
  entrySeoProperty,
  entrySeoIssueCode,
  entrySeoIssue,
  seedIssue,
  seedIssueCode,
  seedType,
  seedField,
  seedApplicationReport,
  entryReferenceUsageEntry,
  entryReferenceUsage,
  computeEntryReferenceUsageInput,
  config,
  definedSeed,
  seoDefaults,
  validatedSeo,
  shortTextDefinition,
  parsedPattern,
  urlPathInput,
  titleField,
  validatedData,
];

console.log(
  `content.ts: ${documentedValueCount} values of the expected kinds and ${typeProofs.length + neverCalled.length} typed declarations resolve against the packed package (no connection opened, no migration applied)`,
);
