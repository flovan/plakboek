/**
 * The host-facing content seed (D-02): `defineContentTypes([...])` is a
 * typed, boot-failing helper in the exact style of
 * `@plakboek/permissions`'s `defineRoles` -- it validates the whole
 * config, collects every problem and throws once, and returns a
 * deep-frozen, normalized seed. The database stays the runtime source of
 * truth for content type and field definitions (D-01); this module is only
 * how host code ships a starting set into it.
 *
 * `applySeed` -- the deploy-time applier: additive (D-03) and
 * drift-reporting (D-04), never overwriting what an admin has already
 * edited -- is added to this module by plan 03-13's second task.
 */
import { LABEL_MAX_LENGTH, TYPE_KEY_PATTERN } from './content-types.js';
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
import { FIELD_KEY_PATTERN, fieldKeyFromLabel } from './fields.js';
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
