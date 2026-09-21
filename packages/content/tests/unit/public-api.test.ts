/**
 * The `@plakboek/content` entry point is a contract. This suite holds that
 * contract as a literal list and fails when any of three things drifts from
 * it: what `src/index.ts` actually exports, what the README's "Public API"
 * tables document, and what stays unreachable -- the transaction-level
 * writers, the unfiltered and row-locking reads, the field-type
 * registration function and every Drizzle schema table.
 *
 * Adding an export means adding it here, to the barrel and to the README in
 * the same change.
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
  defineContentConfig: 'function',
  ContentConfigError: 'class',
  reportContentWarning: 'function',
  // types
  ENTRY_STATUSES: 'constant',
  REVISION_MODES: 'constant',
  // field-types/registry
  FIELD_TYPES: 'constant',
  isFieldType: 'function',
  getFieldTypeDefinition: 'function',
  parseFieldOptions: 'function',
  UnknownFieldTypeError: 'class',
  FieldDefinitionError: 'class',
  // field-types/pattern-safety
  PATTERN_MAX_LENGTH: 'constant',
  isSafePattern: 'function',
  // field-types/short-text
  SHORT_TEXT_MAX_LENGTH: 'constant',
  // field-types/long-text
  LONG_TEXT_MAX_LENGTH: 'constant',
  // field-types/rich-text
  RICH_TEXT_MAX_BYTES: 'constant',
  RICH_TEXT_MAX_DEPTH: 'constant',
  // field-types/url
  URL_MAX_LENGTH: 'constant',
  // field-types/json
  JSON_FIELD_MAX_BYTES: 'constant',
  // field-types/select
  CHOICE_VALUE_PATTERN: 'constant',
  // field-types/image
  ASSET_ID_PATTERN: 'constant',
  // field-types/repeater
  REPEATER_MAX_ITEMS: 'constant',
  // validation
  validateEntryData: 'function',
  FieldValidationError: 'class',
  // slug
  normalizeSlug: 'function',
  isNormalizedSlug: 'function',
  SLUG_MAX_LENGTH: 'constant',
  SLUG_PATTERN: 'constant',
  SlugConflictError: 'class',
  InvalidSlugError: 'class',
  // url-pattern
  URL_PATTERN_TOKENS: 'constant',
  URL_PATTERN_MAX_LENGTH: 'constant',
  UrlPatternError: 'class',
  parseUrlPattern: 'function',
  resolveUrlPath: 'function',
  usesSlugToken: 'function',
  usesDateTokens: 'function',
  // content-types
  TYPE_KEY_PATTERN: 'constant',
  LABEL_MAX_LENGTH: 'constant',
  createContentType: 'function',
  getContentTypeByKey: 'function',
  ContentTypeValidationError: 'class',
  ContentTypeConflictError: 'class',
  PendingDraftsError: 'class',
  RoutableInUseError: 'class',
  ContentTypeHasEntriesError: 'class',
  ContentTypeReferencedError: 'class',
  TitleFieldError: 'class',
  updateContentTypeSettings: 'function',
  setContentTypeSlug: 'function',
  computeContentTypeKeyRenameImpact: 'function',
  renameContentTypeKey: 'function',
  setTitleField: 'function',
  computeContentTypeDeleteImpact: 'function',
  deleteContentType: 'function',
  // fields
  FIELD_KEY_PATTERN: 'constant',
  fieldKeyFromLabel: 'function',
  FieldKeyConflictError: 'class',
  addField: 'function',
  computeAddFieldImpact: 'function',
  listFields: 'function',
  FieldTypeImmutableError: 'class',
  computeFieldUpdateImpact: 'function',
  updateField: 'function',
  computeFieldKeyUsage: 'function',
  renameField: 'function',
  duplicateField: 'function',
  computeFieldDeleteImpact: 'function',
  deleteField: 'function',
  // key-history
  listFieldKeyHistory: 'function',
  // entries
  createEntry: 'function',
  findEntry: 'function',
  findTranslations: 'function',
  listEntries: 'function',
  LocaleNotEnabledError: 'class',
  EntryNotFoundError: 'class',
  // save
  saveEntry: 'function',
  StaleVersionError: 'class',
  // publish
  publishEntry: 'function',
  SlugRequiredError: 'class',
  EntryStateChangedError: 'class',
  // routing
  computeEntryPath: 'function',
  computeUrlPatternChangeImpact: 'function',
  setUrlPattern: 'function',
  UrlPatternRequiredError: 'class',
  UrlCollisionError: 'class',
  UrlPatternInUseError: 'class',
  UrlPatternCollisionError: 'class',
  // lifecycle
  unpublishEntry: 'function',
  scheduleEntry: 'function',
  unscheduleEntry: 'function',
  trashEntry: 'function',
  computeEntryTrashImpact: 'function',
  restoreEntryFromTrash: 'function',
  computeEntryPermanentDeleteImpact: 'function',
  deleteEntryPermanently: 'function',
  EntryStatusError: 'class',
  ScheduleNotInFutureError: 'class',
  // locks
  EDIT_LOCK_HEARTBEAT_SECONDS: 'constant',
  EDIT_LOCK_TTL_SECONDS: 'constant',
  isLockLive: 'function',
  acquireEditLock: 'function',
  renewEditLock: 'function',
  releaseEditLock: 'function',
  takeOverEditLock: 'function',
  EntryLockedError: 'class',
  EditLockingDisabledError: 'class',
  LockTakeoverForbiddenError: 'class',
  LockStateChangedError: 'class',
  // revisions
  listRevisions: 'function',
  computeRestorePreview: 'function',
  restoreRevision: 'function',
  RevisionNotFoundError: 'class',
  // settings
  getRevisionCap: 'function',
  computeRevisionCapImpact: 'function',
  setRevisionCap: 'function',
  RevisionCapError: 'class',
  // translations
  createTranslation: 'function',
  TranslationExistsError: 'class',
  // field-translatable
  computeTranslatableChangeImpact: 'function',
  setFieldTranslatable: 'function',
  // singletons
  getOrCreateSingleton: 'function',
  findSingleton: 'function',
  listSingletonRecords: 'function',
  SingletonEntryError: 'class',
  // locales
  checkContentLocales: 'function',
  // seo
  ENTRY_SEO_PROPERTIES: 'constant',
  EMPTY_ENTRY_SEO: 'constant',
  normalizeEntrySeo: 'function',
  validateEntrySeo: 'function',
  EntrySeoValidationError: 'class',
  SEO_TITLE_MAX_LENGTH: 'constant',
  SEO_DESCRIPTION_MAX_LENGTH: 'constant',
  SEO_CANONICAL_MAX_LENGTH: 'constant',
  // seed
  defineContentTypes: 'function',
  applySeed: 'function',
  ContentTypeSeedError: 'class',
  SEED_ID_PATTERN: 'constant',
  // references
  computeEntryReferenceUsage: 'function',
  ReferenceTargetMissingError: 'class',
  ReferenceTypeNotAllowedError: 'class',
});

/** Every type the entry point exports. Types leave no runtime trace, so this
 * list is compared with the barrel's source and with the README. */
const PUBLIC_TYPES: readonly string[] = Object.freeze([
  // config
  'ContentConfig',
  'ContentConfigIssueCode',
  'ContentConfigIssue',
  'ContentHooks',
  'ContentDeps',
  'SeedDriftEvent',
  'LocaleRemovedEvent',
  // types
  'EntryStatus',
  'RevisionMode',
  'ContentTypeRecord',
  'FieldDefinition',
  'EntryRecord',
  // field-types/registry
  'FieldType',
  'FieldTypeDefinition',
  // field-types/options-map
  'FieldTypeOptionsMap',
  'FieldTypeWidgetMap',
  // validation
  'FieldValidationIssueCode',
  'FieldValidationIssue',
  // url-pattern
  'UrlPatternToken',
  'UrlPatternIssueCode',
  'UrlPatternIssue',
  'ParsedUrlPattern',
  'UrlPathInput',
  // content-types
  'CreateContentTypeInput',
  'ContentTypeValidationIssueCode',
  'ContentTypeValidationIssue',
  'TitleFieldErrorReason',
  'UpdateContentTypeSettingsInput',
  'SetContentTypeSlugInput',
  'RenameContentTypeKeyInput',
  'SetTitleFieldInput',
  'DeleteContentTypeInput',
  // fields
  'AddFieldInput',
  'UpdateFieldInput',
  'RenameFieldInput',
  'DuplicateFieldInput',
  'DeleteFieldInput',
  // key-history
  'FieldKeyHistoryEntry',
  // impact-reports
  'ReferencingField',
  'ContentTypeDeleteImpact',
  'ContentTypeKeyRenameImpact',
  'FieldKeyUsage',
  'FieldDeleteImpact',
  'AddFieldImpact',
  'FieldUpdateImpact',
  // entries
  'CreateEntryInput',
  'FindEntryInput',
  'FindTranslationsInput',
  'ListEntriesInput',
  // save
  'SaveEntryInput',
  // publish
  'PublishEntryInput',
  // routing
  'ComputeEntryPathContentType',
  'UrlPatternCollision',
  'ComputeUrlPatternChangeImpactInput',
  'UrlPatternChangeImpact',
  'SetUrlPatternInput',
  'SetUrlPatternResult',
  // lifecycle
  'UnpublishEntryInput',
  'ScheduleEntryInput',
  'UnscheduleEntryInput',
  'TrashEntryInput',
  'EntryTrashImpact',
  'ComputeEntryTrashImpactInput',
  'RestoreEntryFromTrashInput',
  'EntryPermanentDeleteImpact',
  'ComputeEntryPermanentDeleteImpactInput',
  'DeleteEntryPermanentlyInput',
  // locks
  'AcquireEditLockInput',
  'EditLockGrant',
  'RenewEditLockInput',
  'ReleaseEditLockInput',
  'TakeOverEditLockInput',
  // revisions
  'RevisionKind',
  'RevisionSummary',
  'ListRevisionsInput',
  'RestorePreview',
  'ComputeRestorePreviewInput',
  'RestoreRevisionInput',
  // settings
  'RevisionCapImpact',
  'SetRevisionCapInput',
  'SetRevisionCapResult',
  // translations
  'CreateTranslationInput',
  // field-translatable
  'TranslatableChangeImpactGroup',
  'TranslatableChangeImpact',
  'SetFieldTranslatableInput',
  // singletons
  'SingletonEntryErrorReason',
  'GetOrCreateSingletonInput',
  'FindSingletonInput',
  'ListSingletonRecordsInput',
  // locales
  'LocaleCheckReport',
  // seo
  'EntrySeoProperty',
  'EntrySeo',
  'EntrySeoIssueCode',
  'EntrySeoIssue',
  // seed
  'SeedIssue',
  'SeedIssueCode',
  'SeedContentTypeInput',
  'SeedFieldInput',
  'DefinedContentTypeSeed',
  'SeedApplicationReport',
  // references
  'EntryReferenceUsageEntry',
  'EntryReferenceUsage',
  'ComputeEntryReferenceUsageInput',
]);

/**
 * Names that must stay unreachable from the entry point: the transaction-
 * level writers and their permission/snapshot helpers (T-03-65), the
 * unfiltered and row-locking reads, the field-type registration function,
 * every field type's own definition constant, and every Drizzle schema
 * table (T-03-66).
 */
const INTERNAL_NAMES: readonly string[] = Object.freeze([
  // field-types/registry.ts
  'registerFieldType',
  // save.ts
  'saveEntryInTransaction',
  'decideSavePermission',
  'applySyncedFieldChanges',
  'entrySnapshot',
  // entries.ts / publish.ts
  'getEntry',
  'loadEntryForUpdate',
  'lockTranslationGroupForUpdate',
  'toEntryRecord',
  'readWorkingCopy',
  // revisions.ts
  'recordRevision',
  'pruneSaveRevisions',
  // routing.ts
  'recordUrlHistory',
  'assertPathAvailable',
  'urlCollisionFromUniqueViolation',
  // locks.ts
  'assertRowsWritable',
  // key-history.ts
  'recordContentTypeKeyChange',
  'recordFieldKeyChange',
  // impact-reports.ts
  'countEntries',
  'countEntriesHoldingKey',
  // references.ts
  'syncEntryReferenceIndex',
  'stripTranslationGroupFromReferences',
  'assertReferencesResolvable',
  'collectReferenceValues',
  'removeTranslationGroupFromEntryData',
  // slug.ts
  'generateUniqueEntrySlug',
  'assertEntrySlugAvailable',
  'slugConflictFromUniqueViolation',
  'SlugGenerationError',
  'CONTENT_SLUG_LOCK_NAMESPACE',
  // field-types/*.ts definition constants
  'shortTextFieldType',
  'longTextFieldType',
  'richTextFieldType',
  'numberFieldType',
  'integerFieldType',
  'booleanFieldType',
  'dateTimeFieldType',
  'selectFieldType',
  'multiSelectFieldType',
  'imageFieldType',
  'fileFieldType',
  'referenceFieldType',
  'jsonFieldType',
  'slugFieldFieldType',
  'urlFieldType',
  'repeaterFieldType',
  'choiceSchema',
  // schema.ts -- every table
  'contentTypes',
  'contentTypeFields',
  'contentEntryPublicIdSeq',
  'contentEntries',
  'entryRevisions',
  'contentTypeKeyHistory',
  'contentFieldKeyHistory',
  'contentEntryUrlHistory',
  'contentTypeSeedApplications',
  'contentEntryReferences',
  'contentEngineSettings',
]);

/** One instance per exported error class, built with representative
 * arguments. A class missing here fails the naming case. */
const ERROR_FACTORIES: Readonly<
  Record<string, (Klass: new (...args: never[]) => unknown) => unknown>
> = Object.freeze({
  ContentConfigError: (K) => new (K as new (i: unknown[]) => unknown)([]),
  UnknownFieldTypeError: (K) =>
    new (K as new (f: string) => unknown)('made_up'),
  FieldDefinitionError: (K) =>
    new (K as new (c: string, i: unknown[]) => unknown)('field key', []),
  FieldValidationError: (K) => new (K as new (i: unknown[]) => unknown)([]),
  SlugConflictError: (K) =>
    new (K as new (s: string, l: string, c: string) => unknown)(
      'a-slug',
      'en',
      'content-type-id',
    ),
  InvalidSlugError: (K) =>
    new (K as new (s: string, sug: string) => unknown)(
      'Not-Normalized',
      'not-normalized',
    ),
  UrlPatternError: (K) => new (K as new (i: unknown[]) => unknown)([]),
  ContentTypeValidationError: (K) =>
    new (K as new (i: unknown[]) => unknown)([]),
  ContentTypeConflictError: (K) =>
    new (K as new (c: 'key' | 'slug') => unknown)('key'),
  PendingDraftsError: (K) =>
    new (K as new (k: string, n: number) => unknown)('article', 1),
  RoutableInUseError: (K) =>
    new (K as new (k: string, n: number) => unknown)('article', 1),
  ContentTypeHasEntriesError: (K) =>
    new (K as new (k: string, n: number) => unknown)('article', 1),
  ContentTypeReferencedError: (K) =>
    new (K as new (k: string, f: unknown[]) => unknown)('article', []),
  TitleFieldError: (K) =>
    new (K as new (r: string, m: string) => unknown)(
      'NOT_ROUTABLE',
      'not routable',
    ),
  FieldKeyConflictError: (K) => new (K as new (k: string) => unknown)('title'),
  FieldTypeImmutableError: (K) =>
    new (K as new (k: string) => unknown)('title'),
  LocaleNotEnabledError: (K) => new (K as new (l: string) => unknown)('de'),
  EntryNotFoundError: (K) => new (K as new (id: string) => unknown)('entry-id'),
  StaleVersionError: (K) =>
    new (K as new (id: string, e: number, a: number) => unknown)(
      'entry-id',
      1,
      2,
    ),
  SlugRequiredError: (K) => new (K as new (id: string) => unknown)('entry-id'),
  EntryStateChangedError: (K) =>
    new (K as new (id: string) => unknown)('entry-id'),
  UrlPatternRequiredError: (K) =>
    new (K as new (id: string) => unknown)('content-type-id'),
  UrlCollisionError: (K) =>
    new (K as new (p: string, l: string, c: string | null) => unknown)(
      '/a',
      'en',
      null,
    ),
  UrlPatternInUseError: (K) =>
    new (K as new (id: string, n: number) => unknown)('content-type-id', 1),
  UrlPatternCollisionError: (K) => new (K as new (c: unknown[]) => unknown)([]),
  EntryStatusError: (K) =>
    new (K as new (id: string, s: string, o: string) => unknown)(
      'entry-id',
      'draft',
      'unpublish',
    ),
  ScheduleNotInFutureError: (K) =>
    new (K as new (id: string) => unknown)('entry-id'),
  EntryLockedError: (K) =>
    new (K as new (id: string, l: string, h: string) => unknown)(
      'entry-id',
      'en',
      'user-id',
    ),
  EditLockingDisabledError: (K) =>
    new (K as new (id: string) => unknown)('content-type-id'),
  LockTakeoverForbiddenError: (K) =>
    new (K as new (id: string) => unknown)('entry-id'),
  LockStateChangedError: (K) =>
    new (K as new (id: string) => unknown)('entry-id'),
  RevisionNotFoundError: (K) =>
    new (K as new (id: string, r: string) => unknown)('entry-id', 'rev-id'),
  RevisionCapError: (K) => new (K as new (c: unknown) => unknown)(-1),
  TranslationExistsError: (K) =>
    new (K as new (g: string, l: string) => unknown)('group-id', 'en'),
  SingletonEntryError: (K) =>
    new (K as new (k: string, r: string) => unknown)(
      'site-settings',
      'not-singleton',
    ),
  EntrySeoValidationError: (K) => new (K as new (i: unknown[]) => unknown)([]),
  ContentTypeSeedError: (K) => new (K as new (i: unknown[]) => unknown)([]),
  ReferenceTargetMissingError: (K) =>
    new (K as new (f: string, t: string) => unknown)('author', 'group-id'),
  ReferenceTypeNotAllowedError: (K) =>
    new (K as new (
      f: string,
      t: string,
      a: string,
      allowed: string[],
    ) => unknown)('author', 'group-id', 'page', ['author']),
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

describe('the @plakboek/content public surface', () => {
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

  it('keeps every transaction-level writer, unfiltered read, the field-type registration function and every schema table unreachable', async () => {
    const api: Record<string, unknown> = await import('../../src/index.js');
    for (const name of INTERNAL_NAMES) {
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
