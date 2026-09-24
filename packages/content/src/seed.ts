/**
 * The host-facing content seed (D-02): `defineContentTypes([...])` is a
 * typed, boot-failing helper in the exact style of
 * `@plakboek/permissions`'s `defineRoles` -- it validates the whole
 * config, collects every problem and throws once, and returns a
 * deep-frozen, normalized seed. The database stays the runtime source of
 * truth for content type and field definitions (D-01); this module is only
 * how host code ships a starting set into it.
 *
 * `applySeed` (added by this module's second half) is the deploy-time
 * applier: additive (D-03) and drift-reporting (D-04), never overwriting
 * what an admin has already edited.
 */
import type { AuditActor, AuditDatabase } from '@plakboek/auth';
import { eq } from 'drizzle-orm';
import {
  reportContentWarning,
  type ContentDeps,
  type SeedDriftEvent,
} from './config.js';
import {
  ContentTypeConflictError,
  createContentType,
  getContentTypeByKey,
  LABEL_MAX_LENGTH,
  setTitleField,
  TYPE_KEY_PATTERN,
} from './content-types.js';
import type {
  FieldTypeOptionsMap,
  FieldTypeWidgetMap,
} from './field-types/options-map.js';
import {
  FieldDefinitionError,
  getFieldTypeDefinition,
  isFieldType,
  parseFieldOptions,
  type FieldType,
} from './field-types/registry.js';
import {
  addField,
  FIELD_KEY_PATTERN,
  fieldKeyFromLabel,
  FieldKeyConflictError,
  listFields,
} from './fields.js';
import {
  contentTypeFields,
  contentTypes,
  contentTypeSeedApplications,
} from './schema.js';
import { isNormalizedSlug } from './slug.js';
import type { RevisionMode } from './types.js';

/** A seed id is a permanent identifier: once a host deploys with a given
 * id, it must never change, because `content_type_seed_applications` keys
 * on it (D-03) -- changing it would make `applySeed` treat the item as
 * brand new and create a duplicate. Lowercase letters, digits, dots and
 * hyphens, starting with a letter, up to 128 characters. */
export const SEED_ID_PATTERN = /^[a-z][a-z0-9.-]{0,127}$/;

// ---------------------------------------------------------------------------
// defineContentTypes: the typed, boot-failing helper (D-02)
// ---------------------------------------------------------------------------

/** The shape a host passes to `defineContentTypes` for one field, as a
 * union distributed over `FieldType` (D-02): narrowing on `fieldType`
 * narrows `options`/`widget` to that field type's own shapes, so a field
 * declaring `fieldType: 'number'` with `options: { maxLength: 5 }` --
 * `short_text`'s option -- is a compile error. */
export type SeedFieldInput = {
  readonly [K in FieldType]: {
    readonly seedId: string;
    readonly label: string;
    readonly key?: string;
    readonly fieldType: K;
    readonly options?: FieldTypeOptionsMap[K];
    readonly widget?: FieldTypeWidgetMap[K];
    readonly widgetOptions?: Readonly<Record<string, unknown>>;
    readonly required?: boolean;
    readonly translatable?: boolean;
    readonly defaultValue?: unknown;
  };
}[FieldType];

/** The shape a host passes to `defineContentTypes` for one content type. */
export type SeedContentTypeInput = {
  readonly seedId: string;
  readonly key: string;
  readonly labelSingular: string;
  readonly labelPlural: string;
  readonly slug?: string;
  readonly description?: string;
  readonly routable?: boolean;
  readonly singleton?: boolean;
  readonly drafts?: boolean;
  readonly revisions?: boolean;
  readonly revisionMode?: RevisionMode;
  readonly editLocking?: boolean;
  readonly seo?: boolean;
  readonly titleFieldKey?: string;
  readonly fields: readonly SeedFieldInput[];
};

export type SeedIssueCode =
  | 'INVALID_SEED_CONFIG'
  | 'DUPLICATE_SEED_ID'
  | 'INVALID_SEED_ID'
  | 'INVALID_TYPE_KEY'
  | 'INVALID_FIELD_KEY'
  | 'DUPLICATE_FIELD_KEY'
  | 'EMPTY_LABEL'
  | 'LABEL_TOO_LONG'
  | 'INVALID_SLUG'
  | 'UNKNOWN_FIELD_TYPE'
  | 'INVALID_FIELD_OPTIONS'
  | 'INVALID_WIDGET'
  | 'REVISION_MODE_MISMATCH'
  | 'SINGLETON_ROUTABLE'
  | 'TITLE_FIELD_NOT_FOUND';

export type SeedIssue = {
  readonly code: SeedIssueCode;
  readonly seedId: string | null;
  readonly property?: string;
  readonly message: string;
};

/** Thrown by `defineContentTypes` with every problem found in the seed,
 * collected before throwing once -- never one-issue-at-a-time, following
 * `@plakboek/permissions`'s `RoleConfigError` shape exactly. */
export class ContentTypeSeedError extends Error {
  readonly issues: readonly SeedIssue[];

  constructor(issues: readonly SeedIssue[]) {
    super(
      [
        '@plakboek/content: invalid content type seed:',
        ...issues.map((issue) => issue.message),
      ].join('\n'),
    );
    this.name = 'ContentTypeSeedError';
    this.issues = issues;
  }
}

/** One seeded field after validation: `key` and `options` are always
 * resolved (decided), every other optional property stays `undefined`
 * when the host didn't declare it -- so `applySeed`'s drift comparison can
 * tell "not declared" from "declared and equal to the default", and never
 * reports drift for a property the seed never mentioned. */
type DefinedSeedField = {
  readonly seedId: string;
  readonly key: string;
  readonly label: string;
  readonly fieldType: FieldType;
  readonly options: unknown;
  readonly widget: string | undefined;
  readonly widgetOptions: Readonly<Record<string, unknown>> | undefined;
  readonly required: boolean | undefined;
  readonly translatable: boolean | undefined;
  readonly defaultValue: unknown;
};

/** One seeded content type after validation. Same "undecided stays
 * undefined" rule as `DefinedSeedField` applies to every optional
 * property. */
type DefinedSeedContentType = {
  readonly seedId: string;
  readonly key: string;
  readonly labelSingular: string;
  readonly labelPlural: string;
  readonly slug: string | undefined;
  readonly description: string | undefined;
  readonly routable: boolean | undefined;
  readonly singleton: boolean | undefined;
  readonly drafts: boolean | undefined;
  readonly revisions: boolean | undefined;
  readonly revisionMode: RevisionMode | undefined;
  readonly editLocking: boolean | undefined;
  readonly seo: boolean | undefined;
  readonly titleFieldKey: string | undefined;
  readonly fields: readonly DefinedSeedField[];
};

/** The validated, normalized, deep-frozen result of `defineContentTypes`:
 * the applier receives no undecided `key`/`options` values. */
export type DefinedContentTypeSeed = readonly DefinedSeedContentType[];

function validateSeedId(
  seedId: unknown,
  seen: Set<string>,
  issues: SeedIssue[],
): void {
  if (typeof seedId !== 'string' || !SEED_ID_PATTERN.test(seedId)) {
    issues.push({
      code: 'INVALID_SEED_ID',
      seedId: typeof seedId === 'string' ? seedId : null,
      property: 'seedId',
      message: `seed id "${String(seedId)}" must match ${SEED_ID_PATTERN.source}`,
    });
    return;
  }
  if (seen.has(seedId)) {
    issues.push({
      code: 'DUPLICATE_SEED_ID',
      seedId,
      property: 'seedId',
      message: `seed id "${seedId}" is used more than once`,
    });
    return;
  }
  seen.add(seedId);
}

function validateSeedLabel(
  value: string,
  property: string,
  seedId: string,
  issues: SeedIssue[],
): void {
  if (value.length === 0) {
    issues.push({
      code: 'EMPTY_LABEL',
      seedId,
      property,
      message: `${property} must not be empty or whitespace-only`,
    });
    return;
  }
  if (Array.from(value).length > LABEL_MAX_LENGTH) {
    issues.push({
      code: 'LABEL_TOO_LONG',
      seedId,
      property,
      message: `${property} must be at most ${LABEL_MAX_LENGTH} Unicode code points`,
    });
  }
}

/** Narrows `unknown` to a plain, non-array object without an `as` cast --
 * matches the pattern `fields.ts`/`roles.ts` already use. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursively freezes a value's own plain-object/array structure. Applied
 * once to the whole validated seed, so a returned type, field, or nested
 * options object can never be mutated by a caller (D-02's "deep-frozen
 * normalized seed", mirroring `defineRoles`'s frozen return). */
function deepFreeze<T>(value: T): T {
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    Object.freeze(value);
    for (const item of value) deepFreeze(item);
    return value;
  }
  if (isPlainObject(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
    return value;
  }
  return value;
}

/**
 * Validates and normalizes a host's content type seed (D-02). Collects
 * every problem before throwing one `ContentTypeSeedError` -- a wrong
 * field option, a duplicate seed id, an invalid key, and so on are all
 * reported together, exactly like `defineRoles`. On success, returns a
 * deep-frozen seed typed against all sixteen field types and their own
 * options (`FieldTypeOptionsMap`), so a field declaring the wrong type's
 * option fails to compile before this function is ever called.
 */
export function defineContentTypes<
  const T extends readonly SeedContentTypeInput[],
>(types: T): DefinedContentTypeSeed {
  const issues: SeedIssue[] = [];

  if (!Array.isArray(types)) {
    issues.push({
      code: 'INVALID_SEED_CONFIG',
      seedId: null,
      message:
        'defineContentTypes must be called with an array of content type seeds',
    });
    throw new ContentTypeSeedError(issues);
  }

  const seedIds = new Set<string>();
  const typeKeys = new Set<string>();
  const definedTypes: DefinedSeedContentType[] = [];

  for (const typeInput of types) {
    const typeSeedId = typeInput.seedId;
    validateSeedId(typeSeedId, seedIds, issues);

    if (!TYPE_KEY_PATTERN.test(typeInput.key)) {
      issues.push({
        code: 'INVALID_TYPE_KEY',
        seedId: typeSeedId,
        property: 'key',
        message: `content type key "${typeInput.key}" must match ${TYPE_KEY_PATTERN.source}`,
      });
    } else if (typeKeys.has(typeInput.key)) {
      issues.push({
        code: 'INVALID_TYPE_KEY',
        seedId: typeSeedId,
        property: 'key',
        message: `content type key "${typeInput.key}" is declared more than once`,
      });
    } else {
      typeKeys.add(typeInput.key);
    }

    const labelSingular = typeInput.labelSingular.normalize('NFC').trim();
    const labelPlural = typeInput.labelPlural.normalize('NFC').trim();
    validateSeedLabel(labelSingular, 'labelSingular', typeSeedId, issues);
    validateSeedLabel(labelPlural, 'labelPlural', typeSeedId, issues);

    if (typeInput.slug !== undefined && !isNormalizedSlug(typeInput.slug)) {
      issues.push({
        code: 'INVALID_SLUG',
        seedId: typeSeedId,
        property: 'slug',
        message: `slug "${typeInput.slug}" must already be in normalized form`,
      });
    }

    const revisionModeGiven = typeInput.revisionMode !== undefined;
    if ((typeInput.revisions ?? false) !== revisionModeGiven) {
      issues.push({
        code: 'REVISION_MODE_MISMATCH',
        seedId: typeSeedId,
        property: 'revisionMode',
        message:
          'revisionMode must be set when revisions is true, and omitted otherwise',
      });
    }

    if ((typeInput.singleton ?? false) && (typeInput.routable ?? false)) {
      issues.push({
        code: 'SINGLETON_ROUTABLE',
        seedId: typeSeedId,
        property: 'singleton',
        message: 'a singleton content type cannot also be routable',
      });
    }

    const fieldKeys = new Set<string>();
    const definedFields: DefinedSeedField[] = [];

    for (const fieldInput of typeInput.fields) {
      validateSeedId(fieldInput.seedId, seedIds, issues);

      if (!isFieldType(fieldInput.fieldType)) {
        issues.push({
          code: 'UNKNOWN_FIELD_TYPE',
          seedId: fieldInput.seedId,
          property: 'fieldType',
          message: `field type "${String(fieldInput.fieldType)}" is not registered`,
        });
        continue;
      }

      const definition = getFieldTypeDefinition(fieldInput.fieldType);

      let key: string | undefined;
      if (fieldInput.key !== undefined) {
        if (FIELD_KEY_PATTERN.test(fieldInput.key)) {
          key = fieldInput.key;
        } else {
          issues.push({
            code: 'INVALID_FIELD_KEY',
            seedId: fieldInput.seedId,
            property: 'key',
            message: `field key "${fieldInput.key}" must match ${FIELD_KEY_PATTERN.source}`,
          });
        }
      } else {
        try {
          key = fieldKeyFromLabel(fieldInput.label);
        } catch (error) {
          issues.push({
            code: 'INVALID_FIELD_KEY',
            seedId: fieldInput.seedId,
            property: 'key',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (key !== undefined) {
        if (fieldKeys.has(key)) {
          issues.push({
            code: 'DUPLICATE_FIELD_KEY',
            seedId: fieldInput.seedId,
            property: 'key',
            message: `field key "${key}" is used more than once on content type "${typeInput.key}"`,
          });
        } else {
          fieldKeys.add(key);
        }
      }

      const label = fieldInput.label.normalize('NFC').trim();
      validateSeedLabel(label, 'label', fieldInput.seedId, issues);

      let options: unknown = {};
      try {
        options = parseFieldOptions(
          fieldInput.fieldType,
          fieldInput.options ?? {},
        );
      } catch (error) {
        if (error instanceof FieldDefinitionError) {
          issues.push({
            code: 'INVALID_FIELD_OPTIONS',
            seedId: fieldInput.seedId,
            property: 'options',
            message: error.message,
          });
        } else {
          throw error;
        }
      }

      if (
        fieldInput.widget !== undefined &&
        !definition.widgets.includes(fieldInput.widget)
      ) {
        issues.push({
          code: 'INVALID_WIDGET',
          seedId: fieldInput.seedId,
          property: 'widget',
          message: `widget "${fieldInput.widget}" is not one of "${fieldInput.fieldType}"'s widgets (${definition.widgets.join(', ')})`,
        });
      }

      if (fieldInput.defaultValue !== undefined) {
        const parsedDefault = definition
          .buildValueSchema(options)
          .safeParse(fieldInput.defaultValue);
        if (!parsedDefault.success) {
          issues.push({
            code: 'INVALID_FIELD_OPTIONS',
            seedId: fieldInput.seedId,
            property: 'defaultValue',
            message: parsedDefault.error.issues
              .map((issue) => issue.message)
              .join('; '),
          });
        }
      }

      definedFields.push({
        seedId: fieldInput.seedId,
        key: key ?? fieldInput.label,
        label,
        fieldType: fieldInput.fieldType,
        options,
        widget: fieldInput.widget,
        widgetOptions: fieldInput.widgetOptions,
        required: fieldInput.required,
        translatable: fieldInput.translatable,
        defaultValue: fieldInput.defaultValue,
      });
    }

    if (typeInput.titleFieldKey !== undefined) {
      const namesDeclaredField = definedFields.some(
        (field) => field.key === typeInput.titleFieldKey,
      );
      if (!namesDeclaredField) {
        issues.push({
          code: 'TITLE_FIELD_NOT_FOUND',
          seedId: typeSeedId,
          property: 'titleFieldKey',
          message: `titleFieldKey "${typeInput.titleFieldKey}" does not name any field declared on content type "${typeInput.key}"`,
        });
      }
    }

    definedTypes.push({
      seedId: typeSeedId,
      key: typeInput.key,
      labelSingular,
      labelPlural,
      slug: typeInput.slug,
      description:
        typeInput.description === undefined
          ? undefined
          : typeInput.description.normalize('NFC').trim(),
      routable: typeInput.routable,
      singleton: typeInput.singleton,
      drafts: typeInput.drafts,
      revisions: typeInput.revisions,
      revisionMode: typeInput.revisionMode,
      editLocking: typeInput.editLocking,
      seo: typeInput.seo,
      titleFieldKey: typeInput.titleFieldKey,
      fields: definedFields,
    });
  }

  if (issues.length > 0) {
    throw new ContentTypeSeedError(issues);
  }

  return deepFreeze(definedTypes);
}

// ---------------------------------------------------------------------------
// applySeed: additive application, id tracking and drift notices (D-03, D-04)
// ---------------------------------------------------------------------------

function asSeedApplicationKind(value: string): 'type' | 'field' {
  if (value === 'type' || value === 'field') return value;
  throw new TypeError(
    `@plakboek/content: unexpected seed application kind "${value}" stored for a seed application`,
  );
}

type SeedApplicationRow = {
  readonly seedId: string;
  readonly kind: 'type' | 'field';
  readonly targetId: string;
  readonly appliedAt: Date;
};

/** Reads the recorded application row for `seedId`, or `null` when this
 * seed id has never been applied. */
async function readSeedApplication(
  db: AuditDatabase,
  seedId: string,
): Promise<SeedApplicationRow | null> {
  const [row] = await db
    .select()
    .from(contentTypeSeedApplications)
    .where(eq(contentTypeSeedApplications.seedId, seedId))
    .limit(1);
  if (row === undefined) return null;
  return {
    seedId: row.seedId,
    kind: asSeedApplicationKind(row.kind),
    targetId: row.targetId,
    appliedAt: row.appliedAt,
  };
}

/** Records that `seedId` has been applied, mapping to `targetId`. A
 * conflict on the primary key (a racing deploy recording the same id
 * first) is ignored -- neither caller sees a duplicate-key error (D-03). */
async function recordSeedApplication(
  db: AuditDatabase,
  input: SeedApplicationRow,
): Promise<void> {
  await db
    .insert(contentTypeSeedApplications)
    .values({
      seedId: input.seedId,
      kind: input.kind,
      targetId: input.targetId,
      appliedAt: input.appliedAt,
    })
    .onConflictDoNothing({ target: contentTypeSeedApplications.seedId });
}

/** Deep, key-order-insensitive equality over plain JSON-shaped values --
 * used to compare `options`/`widgetOptions`/`defaultValue` between a seed
 * and a stored (jsonb-round-tripped) row without a re-serialized column
 * ever reading as drift. */
function stableDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => stableDeepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key, index) => key === bKeys[index] && stableDeepEqual(a[key], b[key]),
    );
  }
  return false;
}

type SeedDiff = {
  readonly property: string;
  readonly seededValue: unknown;
  readonly storedValue: unknown;
};

/** The stored shape `compareSeededType` needs: both `getContentTypeByKey`'s
 * `ContentTypeRecord` and a raw `contentTypes` row satisfy this. */
type StoredContentTypeLike = {
  readonly id: string;
  readonly key: string;
  readonly labelSingular: string;
  readonly labelPlural: string;
  readonly description: string | null;
  readonly slug: string;
  readonly routable: boolean;
  readonly singleton: boolean;
  readonly drafts: boolean;
  readonly revisions: boolean;
  readonly revisionMode: string | null;
  readonly editLocking: boolean;
  readonly seo: boolean;
  readonly titleFieldKey: string | null;
};

/** The stored shape `compareSeededField` needs: both `addField`/`listFields`'s
 * `FieldDefinition` and a raw `contentTypeFields` row satisfy this. */
type StoredFieldLike = {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly fieldType: string;
  readonly required: boolean;
  readonly translatable: boolean;
  readonly widget: string;
  readonly options: unknown;
  readonly widgetOptions: unknown;
  readonly defaultValue: unknown;
};

/** Compares only the properties the seed actually declares (D-04): an
 * omitted optional property is never drift. */
function compareSeededType(
  seeded: DefinedSeedContentType,
  stored: StoredContentTypeLike,
): readonly SeedDiff[] {
  const checks: readonly [string, unknown, unknown][] = [
    ['key', seeded.key, stored.key],
    ['labelSingular', seeded.labelSingular, stored.labelSingular],
    ['labelPlural', seeded.labelPlural, stored.labelPlural],
    ['description', seeded.description, stored.description],
    ['slug', seeded.slug, stored.slug],
    ['routable', seeded.routable, stored.routable],
    ['singleton', seeded.singleton, stored.singleton],
    ['drafts', seeded.drafts, stored.drafts],
    ['revisions', seeded.revisions, stored.revisions],
    ['revisionMode', seeded.revisionMode, stored.revisionMode],
    ['editLocking', seeded.editLocking, stored.editLocking],
    ['seo', seeded.seo, stored.seo],
    ['titleFieldKey', seeded.titleFieldKey, stored.titleFieldKey],
  ];
  const diffs: SeedDiff[] = [];
  for (const [property, seededValue, storedValue] of checks) {
    if (seededValue === undefined) continue;
    if (!stableDeepEqual(seededValue, storedValue)) {
      diffs.push({ property, seededValue, storedValue });
    }
  }
  return diffs;
}

/** Compares only the properties the seed actually declares (D-04); `key`,
 * `label`, `fieldType` and `options` are always decided by
 * `defineContentTypes` (never `undefined`), so they are always compared. */
function compareSeededField(
  seeded: DefinedSeedField,
  stored: StoredFieldLike,
): readonly SeedDiff[] {
  const checks: readonly [string, unknown, unknown][] = [
    ['key', seeded.key, stored.key],
    ['label', seeded.label, stored.label],
    ['fieldType', seeded.fieldType, stored.fieldType],
    ['required', seeded.required, stored.required],
    ['translatable', seeded.translatable, stored.translatable],
    ['widget', seeded.widget, stored.widget],
    ['options', seeded.options, stored.options],
    ['widgetOptions', seeded.widgetOptions, stored.widgetOptions],
    ['defaultValue', seeded.defaultValue, stored.defaultValue],
  ];
  const diffs: SeedDiff[] = [];
  for (const [property, seededValue, storedValue] of checks) {
    if (seededValue === undefined) continue;
    if (!stableDeepEqual(seededValue, storedValue)) {
      diffs.push({ property, seededValue, storedValue });
    }
  }
  return diffs;
}

async function readContentTypeById(
  db: AuditDatabase,
  id: string,
): Promise<StoredContentTypeLike | null> {
  const [row] = await db
    .select()
    .from(contentTypes)
    .where(eq(contentTypes.id, id))
    .limit(1);
  return row === undefined ? null : row;
}

async function readContentTypeFieldById(
  db: AuditDatabase,
  id: string,
): Promise<StoredFieldLike | null> {
  const [row] = await db
    .select()
    .from(contentTypeFields)
    .where(eq(contentTypeFields.id, id))
    .limit(1);
  return row === undefined ? null : row;
}

function defaultOnSeedDrift(event: SeedDriftEvent): void {
  // oxlint-disable-next-line no-console -- this is the documented default fallback hook (D-04); a host overrides `onSeedDrift` to route elsewhere
  console.warn(
    `[@plakboek/content] seed "${event.seedId}" (${event.kind}) drifted on "${event.property}": seeded ${JSON.stringify(event.seededValue)}, stored ${JSON.stringify(event.storedValue)}`,
  );
}

/** What one `applySeed` run did. `skipped`'s `'already-applied'` reason is
 * reserved (mirroring `@plakboek/permissions`'s `DeprecatedPermission`
 * pattern): today only `'target-removed'` is ever produced, since an
 * already-applied item whose target still exists is compared for drift
 * rather than recorded as skipped. */
export type SeedApplicationReport = {
  readonly createdTypes: readonly string[];
  readonly createdFields: readonly string[];
  readonly adopted: readonly string[];
  readonly skipped: readonly {
    readonly seedId: string;
    readonly reason: 'already-applied' | 'target-removed';
  }[];
  readonly drift: readonly SeedDriftEvent[];
};

/**
 * Applies a host's defined seed to the database (D-03, D-04). Additive
 * only: creates a missing seeded type or field through the existing
 * audited operations (`createContentType`, `addField`, `setTitleField`),
 * so every creation is permission-checked and audited exactly like a human
 * or MCP-driven change. Never issues an `update`/`delete` against an
 * existing definition row -- a changed already-applied item is reported as
 * drift through `reportContentWarning(deps.hooks?.onSeedDrift, ...)`
 * instead. Every applied seed id is recorded in
 * `content_type_seed_applications` so it is never re-applied, even after
 * the item it created was later renamed or deleted by an admin.
 */
export async function applySeed(
  deps: ContentDeps,
  actor: AuditActor,
  seed: DefinedContentTypeSeed,
): Promise<SeedApplicationReport> {
  const now = deps.now ?? (() => new Date());
  const createdTypes: string[] = [];
  const createdFields: string[] = [];
  const adopted: string[] = [];
  const skipped: {
    seedId: string;
    reason: 'already-applied' | 'target-removed';
  }[] = [];
  const drift: SeedDriftEvent[] = [];

  function recordDrift(
    seedId: string,
    kind: 'type' | 'field',
    diffs: readonly SeedDiff[],
  ): void {
    for (const diff of diffs) {
      const event: SeedDriftEvent = {
        seedId,
        kind,
        property: diff.property,
        seededValue: diff.seededValue,
        storedValue: diff.storedValue,
        occurredAt: now(),
      };
      reportContentWarning(deps.hooks?.onSeedDrift, defaultOnSeedDrift, event);
      drift.push(event);
    }
  }

  for (const seededType of seed) {
    let typeRecord: StoredContentTypeLike | null = null;
    let typeCreatedThisRun = false;

    const recordedTypeApp = await readSeedApplication(
      deps.db,
      seededType.seedId,
    );
    if (recordedTypeApp !== null) {
      const stored = await readContentTypeById(
        deps.db,
        recordedTypeApp.targetId,
      );
      if (stored === null) {
        skipped.push({ seedId: seededType.seedId, reason: 'target-removed' });
      } else {
        typeRecord = stored;
        recordDrift(
          seededType.seedId,
          'type',
          compareSeededType(seededType, stored),
        );
      }
    } else {
      const existing = await getContentTypeByKey(deps.db, seededType.key);
      if (existing !== null) {
        await recordSeedApplication(deps.db, {
          seedId: seededType.seedId,
          kind: 'type',
          targetId: existing.id,
          appliedAt: now(),
        });
        adopted.push(seededType.seedId);
        typeRecord = existing;
        recordDrift(
          seededType.seedId,
          'type',
          compareSeededType(seededType, existing),
        );
      } else {
        try {
          const created = await createContentType(deps, actor, {
            key: seededType.key,
            labelSingular: seededType.labelSingular,
            labelPlural: seededType.labelPlural,
            ...(seededType.slug !== undefined ? { slug: seededType.slug } : {}),
            ...(seededType.description !== undefined
              ? { description: seededType.description }
              : {}),
            ...(seededType.routable !== undefined
              ? { routable: seededType.routable }
              : {}),
            ...(seededType.singleton !== undefined
              ? { singleton: seededType.singleton }
              : {}),
            ...(seededType.drafts !== undefined
              ? { drafts: seededType.drafts }
              : {}),
            ...(seededType.revisions !== undefined
              ? { revisions: seededType.revisions }
              : {}),
            ...(seededType.revisionMode !== undefined
              ? { revisionMode: seededType.revisionMode }
              : {}),
            ...(seededType.editLocking !== undefined
              ? { editLocking: seededType.editLocking }
              : {}),
            ...(seededType.seo !== undefined ? { seo: seededType.seo } : {}),
          });
          await recordSeedApplication(deps.db, {
            seedId: seededType.seedId,
            kind: 'type',
            targetId: created.id,
            appliedAt: now(),
          });
          createdTypes.push(seededType.seedId);
          typeRecord = created;
          typeCreatedThisRun = true;
        } catch (error) {
          if (error instanceof ContentTypeConflictError) {
            const raced = await getContentTypeByKey(deps.db, seededType.key);
            if (raced === null) throw error;
            await recordSeedApplication(deps.db, {
              seedId: seededType.seedId,
              kind: 'type',
              targetId: raced.id,
              appliedAt: now(),
            });
            adopted.push(seededType.seedId);
            typeRecord = raced;
            recordDrift(
              seededType.seedId,
              'type',
              compareSeededType(seededType, raced),
            );
          } else {
            throw error;
          }
        }
      }
    }

    for (const seededField of seededType.fields) {
      const recordedFieldApp = await readSeedApplication(
        deps.db,
        seededField.seedId,
      );
      if (recordedFieldApp !== null) {
        const storedField = await readContentTypeFieldById(
          deps.db,
          recordedFieldApp.targetId,
        );
        if (storedField === null) {
          skipped.push({
            seedId: seededField.seedId,
            reason: 'target-removed',
          });
        } else {
          recordDrift(
            seededField.seedId,
            'field',
            compareSeededField(seededField, storedField),
          );
        }
        continue;
      }

      if (typeRecord === null) {
        // The parent type is unavailable this run (its own seed id was
        // never applied and no natural-key match exists, or it was
        // deleted). None of this plan's tested seeds reach this branch:
        // every field of a fully-deleted type was already recorded before
        // the type was deleted, so it always takes the recorded branch
        // above instead. Guarded defensively rather than assumed.
        continue;
      }

      const existingField = (await listFields(deps.db, typeRecord.id)).find(
        (field) => field.key === seededField.key,
      );

      if (existingField !== undefined) {
        await recordSeedApplication(deps.db, {
          seedId: seededField.seedId,
          kind: 'field',
          targetId: existingField.id,
          appliedAt: now(),
        });
        adopted.push(seededField.seedId);
        recordDrift(
          seededField.seedId,
          'field',
          compareSeededField(seededField, existingField),
        );
        continue;
      }

      try {
        const createdField = await addField(deps, actor, {
          contentTypeKey: seededType.key,
          label: seededField.label,
          key: seededField.key,
          fieldType: seededField.fieldType,
          options: seededField.options,
          ...(seededField.required !== undefined
            ? { required: seededField.required }
            : {}),
          ...(seededField.translatable !== undefined
            ? { translatable: seededField.translatable }
            : {}),
          ...(seededField.widget !== undefined
            ? { widget: seededField.widget }
            : {}),
          ...(seededField.widgetOptions !== undefined
            ? { widgetOptions: seededField.widgetOptions }
            : {}),
          ...(seededField.defaultValue !== undefined
            ? { defaultValue: seededField.defaultValue }
            : {}),
        });
        await recordSeedApplication(deps.db, {
          seedId: seededField.seedId,
          kind: 'field',
          targetId: createdField.id,
          appliedAt: now(),
        });
        createdFields.push(seededField.seedId);
      } catch (error) {
        if (error instanceof FieldKeyConflictError) {
          const raced = (await listFields(deps.db, typeRecord.id)).find(
            (field) => field.key === seededField.key,
          );
          if (raced === undefined) throw error;
          await recordSeedApplication(deps.db, {
            seedId: seededField.seedId,
            kind: 'field',
            targetId: raced.id,
            appliedAt: now(),
          });
          adopted.push(seededField.seedId);
          recordDrift(
            seededField.seedId,
            'field',
            compareSeededField(seededField, raced),
          );
        } else {
          throw error;
        }
      }
    }

    if (seededType.titleFieldKey !== undefined && typeCreatedThisRun) {
      await setTitleField(deps, actor, {
        key: seededType.key,
        fieldKey: seededType.titleFieldKey,
      });
    }
  }

  return {
    createdTypes: Object.freeze(createdTypes),
    createdFields: Object.freeze(createdFields),
    adopted: Object.freeze(adopted),
    skipped: Object.freeze(skipped),
    drift: Object.freeze(drift),
  };
}
