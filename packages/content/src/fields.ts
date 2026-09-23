/**
 * Adding a field to a content type (D-01, D-06): no dynamic DDL -- a field
 * is a row in `content_type_fields`, never a schema-altering statement. The
 * content type row is locked (`SELECT ... FOR UPDATE`) for the duration of
 * the mutation so two concurrent schema edits on the same type serialize.
 */
import type { AuditActor, AuditDatabase } from '@plakboek/auth';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { ContentDeps } from './config.js';
import {
  FieldDefinitionError,
  getFieldTypeDefinition,
  isFieldType,
  parseFieldOptions,
  type FieldType,
} from './field-types/registry.js';
import { getContentTypeByKey } from './content-types.js';
import {
  countEntries,
  countEntriesHoldingKey,
  type AddFieldImpact,
  type FieldDeleteImpact,
  type FieldKeyUsage,
  type FieldUpdateImpact,
} from './impact-reports.js';
import { recordFieldKeyChange } from './key-history.js';
import {
  contentEntries,
  contentEntryReferences,
  contentTypeFields,
  contentTypes,
} from './schema.js';
import type { FieldDefinition } from './types.js';

export const FIELD_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;

const COMBINING_MARKS_PATTERN = /\p{M}+/gu;
const NON_ALPHANUMERIC_RUN_PATTERN = /[^A-Za-z0-9]+/;
const LEADING_DIGIT_PATTERN = /^[0-9]/;
const MAX_FIELD_KEY_LENGTH = 64;

function capitalizeWord(word: string): string {
  const first = word.charAt(0);
  return first === ''
    ? word
    : first.toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Derives a camelCase field key from a label (D-06): "Hero image" ->
 * "heroImage". NFKD-decomposes and strips combining marks first, so
 * diacritics behave like `normalizeSlug`. A key whose first character would
 * be a digit is prefixed with `field`. Throws `FieldDefinitionError` when
 * the label produces nothing usable.
 */
export function fieldKeyFromLabel(label: string): string {
  const decomposed = label
    .normalize('NFKD')
    .replace(COMBINING_MARKS_PATTERN, '');
  const words = decomposed
    .split(NON_ALPHANUMERIC_RUN_PATTERN)
    .filter((word) => word.length > 0);

  if (words.length === 0) {
    throw new FieldDefinitionError('field key', [
      `label "${label}" produced an empty key`,
    ]);
  }

  const camel = words
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : capitalizeWord(word),
    )
    .join('');

  const prefixed = LEADING_DIGIT_PATTERN.test(camel)
    ? `field${capitalizeWord(camel)}`
    : camel;
  const truncated = prefixed.slice(0, MAX_FIELD_KEY_LENGTH);

  if (truncated.length === 0) {
    throw new FieldDefinitionError('field key', [
      `label "${label}" produced an empty key`,
    ]);
  }
  return truncated;
}

export type AddFieldInput = {
  readonly contentTypeKey: string;
  readonly label: string;
  readonly key?: string;
  readonly fieldType: FieldType;
  readonly required?: boolean;
  readonly translatable?: boolean;
  readonly options?: unknown;
  readonly widget?: string;
  readonly widgetOptions?: unknown;
  readonly defaultValue?: unknown;
};

/** Thrown when a field's key collides with an existing field on the same
 * content type. */
export class FieldKeyConflictError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(
      `@plakboek/content: a field with key "${key}" already exists on this content type`,
    );
    this.name = 'FieldKeyConflictError';
    this.key = key;
  }
}

const UNIQUE_VIOLATION = '23505';
const FIELD_TYPE_KEY_UNIQUE_CONSTRAINT = 'content_type_fields_type_key_unique';
const MAX_CAUSE_DEPTH = 3;

function isUniqueViolationOn(error: unknown, constraintName: string): boolean {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) break;
    const code = Reflect.get(current, 'code');
    const constraint = Reflect.get(current, 'constraint_name');
    if (code === UNIQUE_VIOLATION && constraint === constraintName) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function asFieldType(value: string): FieldType {
  if (isFieldType(value)) return value;
  throw new TypeError(
    `@plakboek/content: unexpected field_type "${value}" stored for a field`,
  );
}

function toFieldDefinition(
  row: typeof contentTypeFields.$inferSelect,
): FieldDefinition {
  return {
    id: row.id,
    contentTypeId: row.contentTypeId,
    key: row.key,
    label: row.label,
    fieldType: asFieldType(row.fieldType),
    translatable: row.translatable,
    required: row.required,
    options: row.options,
    widget: row.widget,
    widgetOptions: row.widgetOptions,
    defaultValue: row.defaultValue,
    sortOrder: row.sortOrder,
  };
}

/**
 * Adds a field to a content type. Locks the type row for the duration of
 * the mutation (`SELECT ... FOR UPDATE`), rejects an unregistered field
 * type, validates `options`/`widget`/`defaultValue` against the type's
 * registry definition, and places the field after every existing field
 * (`sort_order` = current max + 1). Runs through `deps.recorder.run`
 * (`content-types:edit` / `field.add`). A duplicate key on the same content
 * type surfaces as `FieldKeyConflictError`.
 */
/** Counts entries of a content type whose `data` does *not* hold `key`
 * (D-18's "no default -> existing entries keep rendering but can't be saved
 * until the field is filled" and its inverse, the backfill target set). */
async function countEntriesWithoutKey(
  db: AuditDatabase,
  contentTypeId: string,
  key: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contentEntries)
    .where(
      and(
        eq(contentEntries.contentTypeId, contentTypeId),
        sql`NOT jsonb_exists(${contentEntries.data}, ${key})`,
      ),
    );
  return row?.count ?? 0;
}

/**
 * Backfills `defaultValue` into every entry of `contentTypeId` lacking
 * `key`, bumping `version` on every row it touches (D-18). A no-op returning
 * `0` when no entry lacks the key. `defaultValue` is bound as a parameter
 * and cast server-side (`::jsonb`), never interpolated into SQL text.
 */
async function backfillDefaultValue(
  tx: AuditDatabase,
  contentTypeId: string,
  key: string,
  defaultValue: unknown,
  now: Date,
): Promise<number> {
  const missingCount = await countEntriesWithoutKey(tx, contentTypeId, key);
  if (missingCount === 0) return 0;
  await tx
    .update(contentEntries)
    .set({
      data: sql`${contentEntries.data} || jsonb_build_object(${key}::text, ${JSON.stringify(defaultValue)}::jsonb)`,
      version: sql`${contentEntries.version} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(contentEntries.contentTypeId, contentTypeId),
        sql`NOT jsonb_exists(${contentEntries.data}, ${key})`,
      ),
    );
  return missingCount;
}

/**
 * Adds a field to a content type. Locks the type row for the duration of
 * the mutation (`SELECT ... FOR UPDATE`), rejects an unregistered field
 * type, validates `options`/`widget`/`defaultValue` against the type's
 * registry definition, and places the field after every existing field
 * (`sort_order` = current max + 1). When the field is `required` and the
 * type already holds entries, a `defaultValue` backfills into every entry
 * lacking the key (D-18); without a default those entries are left as-is
 * and blocked from saving until the field is filled (`validateEntryData`'s
 * existing `REQUIRED` check). Runs through `deps.recorder.run`
 * (`content-types:edit` / `field.add`). A duplicate key on the same content
 * type surfaces as `FieldKeyConflictError`.
 */
export async function addField(
  deps: ContentDeps,
  actor: AuditActor,
  input: AddFieldInput,
): Promise<FieldDefinition> {
  const now = deps.now ?? (() => new Date());
  const key = input.key ?? fieldKeyFromLabel(input.label);
  if (!FIELD_KEY_PATTERN.test(key)) {
    throw new FieldDefinitionError('field key', [
      `key "${key}" must match ${FIELD_KEY_PATTERN.source}`,
    ]);
  }
  const label = input.label.normalize('NFC').trim();

  try {
    return await deps.recorder.run(
      actor,
      {
        permission: 'content-types:edit',
        action: 'field.add',
        entityType: 'content_type_field',
      },
      async (tx) => {
        const [typeRow] = await tx
          .select({ id: contentTypes.id })
          .from(contentTypes)
          .where(eq(contentTypes.key, input.contentTypeKey))
          .for('update');
        if (typeRow === undefined) {
          throw new Error(
            `@plakboek/content: no content type registered for key "${input.contentTypeKey}"`,
          );
        }

        const definition = getFieldTypeDefinition(input.fieldType);
        const options = parseFieldOptions(input.fieldType, input.options ?? {});
        const widget = input.widget ?? definition.defaultWidget;
        if (!definition.widgets.includes(widget)) {
          throw new FieldDefinitionError('widget', [
            `widget "${widget}" is not one of "${input.fieldType}"'s widgets (${definition.widgets.join(', ')})`,
          ]);
        }
        let validatedDefault: unknown;
        if (input.defaultValue !== undefined) {
          const parsedDefault = definition
            .buildValueSchema(options)
            .safeParse(input.defaultValue);
          if (!parsedDefault.success) {
            throw new FieldDefinitionError(
              'default value',
              parsedDefault.error.issues.map((issue) => issue.message),
            );
          }
          validatedDefault = parsedDefault.data;
        }

        const [maxRow] = await tx
          .select({
            maxSortOrder: sql<
              number | null
            >`max(${contentTypeFields.sortOrder})`,
          })
          .from(contentTypeFields)
          .where(eq(contentTypeFields.contentTypeId, typeRow.id));
        const sortOrder = (maxRow?.maxSortOrder ?? -1) + 1;

        const createdAt = now();
        const [row] = await tx
          .insert(contentTypeFields)
          .values({
            contentTypeId: typeRow.id,
            key,
            label,
            fieldType: input.fieldType,
            translatable: input.translatable ?? true,
            required: input.required ?? false,
            options,
            widget,
            widgetOptions: input.widgetOptions ?? {},
            defaultValue: input.defaultValue ?? null,
            sortOrder,
            createdAt,
            updatedAt: createdAt,
          })
          .returning();
        if (row === undefined) {
          throw new Error('@plakboek/content: field insert returned no row');
        }
        const record = toFieldDefinition(row);

        const required = input.required ?? false;
        let entriesToBackfill = 0;
        let entriesBlockedUntilFilled = 0;
        if (required) {
          if (validatedDefault !== undefined) {
            entriesToBackfill = await backfillDefaultValue(
              tx,
              typeRow.id,
              key,
              validatedDefault,
              createdAt,
            );
          } else {
            entriesBlockedUntilFilled = await countEntriesWithoutKey(
              tx,
              typeRow.id,
              key,
            );
          }
        }

        return {
          result: record,
          after: {
            field: record,
            entriesToBackfill,
            entriesBlockedUntilFilled,
          },
        };
      },
    );
  } catch (error) {
    if (isUniqueViolationOn(error, FIELD_TYPE_KEY_UNIQUE_CONSTRAINT)) {
      throw new FieldKeyConflictError(key);
    }
    throw error;
  }
}

/** Reports what adding a required field with `input.defaultValue` and
 * `input.required` would touch on `input.contentTypeKey`'s entries,
 * before the field exists (D-18). Re-run inside `addField`'s own
 * transaction, so the counts applied always match. */
export async function computeAddFieldImpact(
  db: AuditDatabase,
  input: Pick<AddFieldInput, 'contentTypeKey' | 'required' | 'defaultValue'>,
): Promise<AddFieldImpact> {
  const type = await getContentTypeByKey(db, input.contentTypeKey);
  if (type === null) {
    throw new Error(
      `@plakboek/content: no content type registered for key "${input.contentTypeKey}"`,
    );
  }
  const entryCount = await countEntries(db, type.id);
  const required = input.required ?? false;
  const hasDefault = input.defaultValue !== undefined;
  return {
    entryCount,
    entriesToBackfill: required && hasDefault ? entryCount : 0,
    entriesBlockedUntilFilled: required && !hasDefault ? entryCount : 0,
  };
}

/** Lists a content type's fields, ordered by `sort_order` then `id`. Not
 * permission-gated: reads are internal API, gated by later phases'
 * HTTP/admin layers. */
export async function listFields(
  db: AuditDatabase,
  contentTypeId: string,
): Promise<FieldDefinition[]> {
  const rows = await db
    .select()
    .from(contentTypeFields)
    .where(eq(contentTypeFields.contentTypeId, contentTypeId))
    .orderBy(asc(contentTypeFields.sortOrder), asc(contentTypeFields.id));
  return rows.map(toFieldDefinition);
}

/** Reads one field by its content type's key and its own key, joined
 * through `content_types`, or `null` when either doesn't exist. */
async function getFieldByKeys(
  db: AuditDatabase,
  contentTypeKey: string,
  fieldKey: string,
): Promise<FieldDefinition | null> {
  const [row] = await db
    .select({ field: contentTypeFields })
    .from(contentTypeFields)
    .innerJoin(
      contentTypes,
      eq(contentTypeFields.contentTypeId, contentTypes.id),
    )
    .where(
      and(
        eq(contentTypes.key, contentTypeKey),
        eq(contentTypeFields.key, fieldKey),
      ),
    )
    .limit(1);
  return row === undefined ? null : toFieldDefinition(row.field);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A repeater's sub-field keys, from its raw `options.fields` -- `[]` for
 * anything not shaped like repeater options. */
function repeaterSubFieldKeys(options: unknown): readonly string[] {
  if (!isPlainObject(options) || !Array.isArray(options.fields)) return [];
  const keys: string[] = [];
  for (const subField of options.fields) {
    if (isPlainObject(subField) && typeof subField.key === 'string') {
      keys.push(subField.key);
    }
  }
  return keys;
}

/** Sub-field keys present in `oldOptions` but no longer in `newOptions` --
 * what a repeater `updateField` is about to strip from stored data. */
function removedRepeaterSubFieldKeys(
  oldOptions: unknown,
  newOptions: unknown,
): readonly string[] {
  const newKeys = new Set(repeaterSubFieldKeys(newOptions));
  return repeaterSubFieldKeys(oldOptions).filter((key) => !newKeys.has(key));
}

/** Counts individual repeater items (not entries) across every entry of
 * `contentTypeId` that hold a value for at least one of `removedKeys` under
 * `fieldKey` -- read into application code rather than a lateral-join SQL
 * aggregate, since this is a bounded, informational impact number, not a
 * per-entry-round-trip mutation. */
async function countRepeaterItemsLosingValues(
  db: AuditDatabase,
  contentTypeId: string,
  fieldKey: string,
  removedKeys: readonly string[],
): Promise<number> {
  if (removedKeys.length === 0) return 0;
  const rows = await db
    .select({ value: sql<unknown>`${contentEntries.data} -> ${fieldKey}` })
    .from(contentEntries)
    .where(eq(contentEntries.contentTypeId, contentTypeId));

  let count = 0;
  for (const row of rows) {
    if (!Array.isArray(row.value)) continue;
    for (const item of row.value) {
      if (
        isPlainObject(item) &&
        removedKeys.some((key) => Object.hasOwn(item, key))
      ) {
        count += 1;
      }
    }
  }
  return count;
}

/**
 * Strips every key in `removedKeys` from every item of the repeater array
 * stored at `fieldKey`, for every entry of `contentTypeId` that holds the
 * key, in one set-based `UPDATE` (T-03-25: no per-row round trips). A no-op
 * when `removedKeys` is empty.
 */
async function stripRemovedRepeaterSubFieldKeys(
  tx: AuditDatabase,
  contentTypeId: string,
  fieldKey: string,
  removedKeys: readonly string[],
  now: Date,
): Promise<void> {
  if (removedKeys.length === 0) return;
  const removedKeysArray = sql`ARRAY[${sql.join(
    removedKeys.map((key) => sql`${key}::text`),
    sql`, `,
  )}]::text[]`;
  await tx
    .update(contentEntries)
    .set({
      data: sql`jsonb_set(${contentEntries.data}, ARRAY[${fieldKey}]::text[], COALESCE((SELECT jsonb_agg(item - ${removedKeysArray}) FROM jsonb_array_elements(${contentEntries.data} -> ${fieldKey}) AS item), '[]'::jsonb))`,
      version: sql`${contentEntries.version} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(contentEntries.contentTypeId, contentTypeId),
        sql`jsonb_exists(${contentEntries.data}, ${fieldKey})`,
      ),
    );
}

/** Thrown by `updateField` when `input` carries an own property named
 * `fieldType` -- a field's storage type never changes after creation
 * (D-08). `UpdateFieldInput` has no `fieldType` property, but this is
 * checked at runtime too: a caller passing an untyped/parsed object can
 * still carry one. */
export class FieldTypeImmutableError extends Error {
  readonly fieldKey: string;

  constructor(fieldKey: string) {
    super(
      `@plakboek/content: field "${fieldKey}"'s type cannot be changed after creation (D-08); delete and re-add the field instead`,
    );
    this.name = 'FieldTypeImmutableError';
    this.fieldKey = fieldKey;
  }
}

export type UpdateFieldInput = {
  readonly contentTypeKey: string;
  readonly fieldKey: string;
  readonly label?: string;
  readonly required?: boolean;
  readonly options?: unknown;
  readonly widget?: string;
  readonly widgetOptions?: unknown;
  readonly defaultValue?: unknown;
};

/** Reports what `updateField(input)` would touch, without applying it:
 * entries whose stored value would fail `input.options`'s new rules
 * (checked in application code by re-running the new value schema over
 * every stored value), entries that would be backfilled if `required` is
 * turning on with a `defaultValue`, and -- for a repeater losing sub-fields
 * -- how many stored items hold a value for one of them. Re-run inside
 * `updateField`'s own transaction, so the counts applied always match. */
export async function computeFieldUpdateImpact(
  db: AuditDatabase,
  input: UpdateFieldInput,
): Promise<FieldUpdateImpact> {
  const field = await getFieldByKeys(db, input.contentTypeKey, input.fieldKey);
  if (field === null) {
    throw new Error(
      `@plakboek/content: no field "${input.fieldKey}" on content type "${input.contentTypeKey}"`,
    );
  }

  let entriesFailingNewRules = 0;
  if (input.options !== undefined) {
    const definition = getFieldTypeDefinition(field.fieldType);
    const newOptions = parseFieldOptions(field.fieldType, input.options);
    const schema = definition.buildValueSchema(newOptions);
    const rows = await db
      .select({ value: sql<unknown>`${contentEntries.data} -> ${field.key}` })
      .from(contentEntries)
      .where(eq(contentEntries.contentTypeId, field.contentTypeId));
    for (const row of rows) {
      if (definition.isEmptyValue(row.value)) continue;
      if (!schema.safeParse(row.value).success) entriesFailingNewRules += 1;
    }
  }

  let entriesToBackfill = 0;
  const becomingRequired = input.required === true && !field.required;
  if (becomingRequired && input.defaultValue !== undefined) {
    entriesToBackfill = await countEntriesWithoutKey(
      db,
      field.contentTypeId,
      field.key,
    );
  }

  let repeaterItemsLosingValues = 0;
  if (field.fieldType === 'repeater' && input.options !== undefined) {
    const removedKeys = removedRepeaterSubFieldKeys(
      field.options,
      input.options,
    );
    repeaterItemsLosingValues = await countRepeaterItemsLosingValues(
      db,
      field.contentTypeId,
      field.key,
      removedKeys,
    );
  }

  return {
    entriesFailingNewRules,
    entriesToBackfill,
    repeaterItemsLosingValues,
  };
}

/**
 * Changes a field's label, `required`, `options`, `widget`, `widgetOptions`
 * or `defaultValue` -- never its `fieldType` (D-08, `FieldTypeImmutableError`
 * for any input carrying one, checked at runtime). Locks the type row for
 * the duration of the mutation (`SELECT ... FOR UPDATE`), re-validates
 * `options`/`widget`/`defaultValue` against the field's (unchanged) type
 * definition, and applies the same required-field backfill-or-block rule as
 * `addField` when `required` is turning on (D-18). For a repeater whose
 * `options.fields` drops one or more sub-fields, strips those keys from
 * every stored item in one set-based `UPDATE`. Runs through
 * `deps.recorder.run` (`content-types:edit` / `field.update`).
 */
export async function updateField(
  deps: ContentDeps,
  actor: AuditActor,
  input: UpdateFieldInput,
): Promise<FieldDefinition> {
  if (Object.hasOwn(input, 'fieldType')) {
    throw new FieldTypeImmutableError(input.fieldKey);
  }
  const now = deps.now ?? (() => new Date());

  return await deps.recorder.run(
    actor,
    {
      permission: 'content-types:edit',
      action: 'field.update',
      entityType: 'content_type_field',
    },
    async (tx) => {
      const [typeRow] = await tx
        .select({ id: contentTypes.id })
        .from(contentTypes)
        .where(eq(contentTypes.key, input.contentTypeKey))
        .for('update');
      if (typeRow === undefined) {
        throw new Error(
          `@plakboek/content: no content type registered for key "${input.contentTypeKey}"`,
        );
      }

      const [current] = await tx
        .select()
        .from(contentTypeFields)
        .where(
          and(
            eq(contentTypeFields.contentTypeId, typeRow.id),
            eq(contentTypeFields.key, input.fieldKey),
          ),
        );
      if (current === undefined) {
        throw new Error(
          `@plakboek/content: no field "${input.fieldKey}" on content type "${input.contentTypeKey}"`,
        );
      }
      const fieldType = asFieldType(current.fieldType);

      const definition = getFieldTypeDefinition(fieldType);
      const options =
        input.options !== undefined
          ? parseFieldOptions(fieldType, input.options)
          : current.options;
      const widget = input.widget ?? current.widget;
      if (!definition.widgets.includes(widget)) {
        throw new FieldDefinitionError('widget', [
          `widget "${widget}" is not one of "${fieldType}"'s widgets (${definition.widgets.join(', ')})`,
        ]);
      }

      let validatedDefault = current.defaultValue;
      if (input.defaultValue !== undefined) {
        const parsedDefault = definition
          .buildValueSchema(options)
          .safeParse(input.defaultValue);
        if (!parsedDefault.success) {
          throw new FieldDefinitionError(
            'default value',
            parsedDefault.error.issues.map((issue) => issue.message),
          );
        }
        validatedDefault = parsedDefault.data;
      }

      const required = input.required ?? current.required;
      const becomingRequired = input.required === true && !current.required;
      const updatedAt = now();

      // The backfill gate below intentionally reads `input.defaultValue`,
      // not `validatedDefault`. A field with no default ever set stores
      // `null` in the same column an explicit `defaultValue: null` would
      // (addField's own insert coalesces `undefined` to `null`), so
      // `current.defaultValue` cannot tell "explicitly defaulted to null"
      // apart from "never defaulted". Only this call's own input can, and
      // computeFieldUpdateImpact's preview reads the same signal (D-18,
      // B-CR-02: the preview and the applied backfill count must agree).
      let entriesToBackfill = 0;
      if (becomingRequired && input.defaultValue !== undefined) {
        entriesToBackfill = await backfillDefaultValue(
          tx,
          typeRow.id,
          current.key,
          validatedDefault,
          updatedAt,
        );
      }

      let repeaterItemsLosingValues = 0;
      if (fieldType === 'repeater' && input.options !== undefined) {
        const removedKeys = removedRepeaterSubFieldKeys(
          current.options,
          options,
        );
        if (removedKeys.length > 0) {
          repeaterItemsLosingValues = await countRepeaterItemsLosingValues(
            tx,
            typeRow.id,
            current.key,
            removedKeys,
          );
          await stripRemovedRepeaterSubFieldKeys(
            tx,
            typeRow.id,
            current.key,
            removedKeys,
            updatedAt,
          );
        }
      }

      const [row] = await tx
        .update(contentTypeFields)
        .set({
          label:
            input.label !== undefined
              ? input.label.normalize('NFC').trim()
              : current.label,
          required,
          options,
          widget,
          widgetOptions: input.widgetOptions ?? current.widgetOptions,
          defaultValue:
            input.defaultValue !== undefined
              ? validatedDefault
              : current.defaultValue,
          updatedAt,
        })
        .where(eq(contentTypeFields.id, current.id))
        .returning();
      if (row === undefined) {
        throw new Error('@plakboek/content: field update returned no row');
      }
      const record = toFieldDefinition(row);
      return {
        result: record,
        after: { field: record, entriesToBackfill, repeaterItemsLosingValues },
      };
    },
  );
}

/** Reports what renaming `input.fieldKey` to a new key would touch: how
 * many entries currently hold a value under it (`entriesHoldingValue`,
 * `suggestDuplicate` true above zero -- D-09's "suggest Duplicate field"
 * warning) and bindings (always `0` today; see `impact-reports.ts`). */
export async function computeFieldKeyUsage(
  db: AuditDatabase,
  input: { readonly contentTypeKey: string; readonly fieldKey: string },
): Promise<FieldKeyUsage> {
  const field = await getFieldByKeys(db, input.contentTypeKey, input.fieldKey);
  if (field === null) {
    throw new Error(
      `@plakboek/content: no field "${input.fieldKey}" on content type "${input.contentTypeKey}"`,
    );
  }
  const entriesHoldingValue = await countEntriesHoldingKey(
    db,
    field.contentTypeId,
    field.key,
  );
  return {
    entriesHoldingValue,
    bindingsUsingKey: 0,
    suggestDuplicate: entriesHoldingValue > 0,
  };
}

export type RenameFieldInput = {
  readonly contentTypeKey: string;
  readonly fieldKey: string;
  readonly newKey: string;
};

/**
 * Renames a field's key: moves its value to the new key in every entry of
 * the type holding it (`data - old || jsonb_build_object(new, data -> old)`,
 * bumping `version`), records a `content_field_key_history` row, and moves
 * the type's `title_field_key` designation with it when it named the old
 * key -- all in the same transaction. A `newKey` collision surfaces as
 * `FieldKeyConflictError`. Runs through `deps.recorder.run`
 * (`content-types:edit` / `field.rename-key`).
 */
export async function renameField(
  deps: ContentDeps,
  actor: AuditActor,
  input: RenameFieldInput,
): Promise<FieldDefinition> {
  if (!FIELD_KEY_PATTERN.test(input.newKey)) {
    throw new FieldDefinitionError('field key', [
      `key "${input.newKey}" must match ${FIELD_KEY_PATTERN.source}`,
    ]);
  }
  const now = deps.now ?? (() => new Date());

  try {
    return await deps.recorder.run(
      actor,
      {
        permission: 'content-types:edit',
        action: 'field.rename-key',
        entityType: 'content_type_field',
      },
      async (tx) => {
        const [typeRow] = await tx
          .select()
          .from(contentTypes)
          .where(eq(contentTypes.key, input.contentTypeKey))
          .for('update');
        if (typeRow === undefined) {
          throw new Error(
            `@plakboek/content: no content type registered for key "${input.contentTypeKey}"`,
          );
        }

        const [current] = await tx
          .select()
          .from(contentTypeFields)
          .where(
            and(
              eq(contentTypeFields.contentTypeId, typeRow.id),
              eq(contentTypeFields.key, input.fieldKey),
            ),
          );
        if (current === undefined) {
          throw new Error(
            `@plakboek/content: no field "${input.fieldKey}" on content type "${input.contentTypeKey}"`,
          );
        }

        const updatedAt = now();

        await tx
          .update(contentEntries)
          .set({
            data: sql`(${contentEntries.data} - ${current.key}::text) || jsonb_build_object(${input.newKey}::text, ${contentEntries.data} -> ${current.key}::text)`,
            version: sql`${contentEntries.version} + 1`,
            updatedAt,
          })
          .where(
            and(
              eq(contentEntries.contentTypeId, typeRow.id),
              sql`jsonb_exists(${contentEntries.data}, ${current.key})`,
            ),
          );

        const [row] = await tx
          .update(contentTypeFields)
          .set({ key: input.newKey, updatedAt })
          .where(eq(contentTypeFields.id, current.id))
          .returning();
        if (row === undefined) {
          throw new Error(
            '@plakboek/content: field key rename returned no row',
          );
        }

        await recordFieldKeyChange(tx, {
          contentTypeId: typeRow.id,
          fieldId: current.id,
          oldKey: current.key,
          newKey: input.newKey,
          changedBy: actor.userId,
          changedAt: updatedAt,
        });

        if (typeRow.titleFieldKey === current.key) {
          await tx
            .update(contentTypes)
            .set({ titleFieldKey: input.newKey, updatedAt })
            .where(eq(contentTypes.id, typeRow.id));
        }

        const record = toFieldDefinition(row);
        return { result: record, after: record };
      },
    );
  } catch (error) {
    if (isUniqueViolationOn(error, FIELD_TYPE_KEY_UNIQUE_CONSTRAINT)) {
      throw new FieldKeyConflictError(input.newKey);
    }
    throw error;
  }
}

export type DuplicateFieldInput = {
  readonly contentTypeKey: string;
  readonly fieldKey: string;
  readonly newKey?: string;
  readonly label?: string;
  readonly copyValues?: boolean;
};

/**
 * Copies a field's definition under a new key (D-09's "Duplicate field"
 * suggestion offered alongside a rename-in-use warning) and, unless
 * `copyValues` is `false` (default `true`), copies every entry's value to
 * the new key too, in the same transaction. `newKey` defaults to
 * `fieldKeyFromLabel(label)` when `label` is given, else `"<key>Copy"`.
 * Content types have no equivalent duplicate operation (D-09: duplication
 * applies to fields only). Runs through `deps.recorder.run`
 * (`content-types:edit` / `field.duplicate`).
 */
export async function duplicateField(
  deps: ContentDeps,
  actor: AuditActor,
  input: DuplicateFieldInput,
): Promise<FieldDefinition> {
  const copyValues = input.copyValues ?? true;

  const source = await getFieldByKeys(
    deps.db,
    input.contentTypeKey,
    input.fieldKey,
  );
  if (source === null) {
    throw new Error(
      `@plakboek/content: no field "${input.fieldKey}" on content type "${input.contentTypeKey}"`,
    );
  }
  const label =
    input.label !== undefined
      ? input.label.normalize('NFC').trim()
      : source.label;
  const newKey =
    input.newKey ??
    (input.label !== undefined
      ? fieldKeyFromLabel(input.label)
      : `${source.key}Copy`);
  if (!FIELD_KEY_PATTERN.test(newKey)) {
    throw new FieldDefinitionError('field key', [
      `key "${newKey}" must match ${FIELD_KEY_PATTERN.source}`,
    ]);
  }

  const now = deps.now ?? (() => new Date());

  try {
    return await deps.recorder.run(
      actor,
      {
        permission: 'content-types:edit',
        action: 'field.duplicate',
        entityType: 'content_type_field',
      },
      async (tx) => {
        const [typeRow] = await tx
          .select({ id: contentTypes.id })
          .from(contentTypes)
          .where(eq(contentTypes.key, input.contentTypeKey))
          .for('update');
        if (typeRow === undefined) {
          throw new Error(
            `@plakboek/content: no content type registered for key "${input.contentTypeKey}"`,
          );
        }

        const [current] = await tx
          .select()
          .from(contentTypeFields)
          .where(eq(contentTypeFields.id, source.id));
        if (current === undefined) {
          throw new Error(
            `@plakboek/content: field "${input.fieldKey}" no longer exists on content type "${input.contentTypeKey}"`,
          );
        }

        const [maxRow] = await tx
          .select({
            maxSortOrder: sql<
              number | null
            >`max(${contentTypeFields.sortOrder})`,
          })
          .from(contentTypeFields)
          .where(eq(contentTypeFields.contentTypeId, typeRow.id));
        const sortOrder = (maxRow?.maxSortOrder ?? -1) + 1;

        const createdAt = now();
        const [row] = await tx
          .insert(contentTypeFields)
          .values({
            contentTypeId: typeRow.id,
            key: newKey,
            label,
            fieldType: current.fieldType,
            translatable: current.translatable,
            required: current.required,
            options: current.options,
            widget: current.widget,
            widgetOptions: current.widgetOptions,
            defaultValue: current.defaultValue,
            sortOrder,
            createdAt,
            updatedAt: createdAt,
          })
          .returning();
        if (row === undefined) {
          throw new Error(
            '@plakboek/content: field duplicate insert returned no row',
          );
        }

        if (copyValues) {
          await tx
            .update(contentEntries)
            .set({
              data: sql`${contentEntries.data} || jsonb_build_object(${newKey}::text, ${contentEntries.data} -> ${current.key}::text)`,
              version: sql`${contentEntries.version} + 1`,
              updatedAt: createdAt,
            })
            .where(
              and(
                eq(contentEntries.contentTypeId, typeRow.id),
                sql`jsonb_exists(${contentEntries.data}, ${current.key})`,
              ),
            );
        }

        const record = toFieldDefinition(row);
        return { result: record, after: record };
      },
    );
  } catch (error) {
    if (isUniqueViolationOn(error, FIELD_TYPE_KEY_UNIQUE_CONSTRAINT)) {
      throw new FieldKeyConflictError(newKey);
    }
    throw error;
  }
}

/** Reports what deleting `input.fieldKey` would touch: how many entries
 * currently hold a value under it, and whether it is the type's title
 * field (its designation would be cleared). Re-run inside `deleteField`'s
 * own transaction, so the counts applied always match. */
export async function computeFieldDeleteImpact(
  db: AuditDatabase,
  input: { readonly contentTypeKey: string; readonly fieldKey: string },
): Promise<FieldDeleteImpact> {
  const type = await getContentTypeByKey(db, input.contentTypeKey);
  if (type === null) {
    throw new Error(
      `@plakboek/content: no content type registered for key "${input.contentTypeKey}"`,
    );
  }
  const field = await getFieldByKeys(db, input.contentTypeKey, input.fieldKey);
  if (field === null) {
    throw new Error(
      `@plakboek/content: no field "${input.fieldKey}" on content type "${input.contentTypeKey}"`,
    );
  }
  const entriesHoldingValue = await countEntriesHoldingKey(
    db,
    field.contentTypeId,
    field.key,
  );
  return {
    entriesHoldingValue,
    clearsTitleField: type.titleFieldKey === field.key,
    bindingsUsingKey: 0,
  };
}

export type DeleteFieldInput = {
  readonly contentTypeKey: string;
  readonly fieldKey: string;
};

/**
 * Deletes a field: removes its key from every entry of the type (`data -
 * key`, bumping `version`), deletes its `content_entry_references` rows
 * (D-40's reverse-reference index), clears the type's `title_field_key`
 * when it named this field, and deletes the field row itself -- all in the
 * same transaction. Revision snapshots are not rewritten (D-07). Runs
 * through `deps.recorder.run` (`content-types:edit` / `field.delete`).
 */
export async function deleteField(
  deps: ContentDeps,
  actor: AuditActor,
  input: DeleteFieldInput,
): Promise<void> {
  const now = deps.now ?? (() => new Date());

  await deps.recorder.run(
    actor,
    {
      permission: 'content-types:edit',
      action: 'field.delete',
      entityType: 'content_type_field',
    },
    async (tx) => {
      const [typeRow] = await tx
        .select()
        .from(contentTypes)
        .where(eq(contentTypes.key, input.contentTypeKey))
        .for('update');
      if (typeRow === undefined) {
        throw new Error(
          `@plakboek/content: no content type registered for key "${input.contentTypeKey}"`,
        );
      }

      const [current] = await tx
        .select()
        .from(contentTypeFields)
        .where(
          and(
            eq(contentTypeFields.contentTypeId, typeRow.id),
            eq(contentTypeFields.key, input.fieldKey),
          ),
        );
      if (current === undefined) {
        throw new Error(
          `@plakboek/content: no field "${input.fieldKey}" on content type "${input.contentTypeKey}"`,
        );
      }

      const updatedAt = now();
      const entriesHoldingValue = await countEntriesHoldingKey(
        tx,
        typeRow.id,
        current.key,
      );

      await tx
        .update(contentEntries)
        .set({
          // The `::text` cast is explicit, not incidental (WR-02): `-` is
          // ambiguous for an untyped parameter, this package also lists
          // `pg` as a dependency and a future deployment on that driver
          // would not get postgres-js's parameter framing, and the two
          // sibling mutations in this file (renameField, duplicateField)
          // already carry it.
          data: sql`${contentEntries.data} - ${current.key}::text`,
          version: sql`${contentEntries.version} + 1`,
          updatedAt,
        })
        .where(
          and(
            eq(contentEntries.contentTypeId, typeRow.id),
            sql`jsonb_exists(${contentEntries.data}, ${current.key})`,
          ),
        );

      await tx
        .delete(contentEntryReferences)
        .where(eq(contentEntryReferences.fieldId, current.id));

      const clearsTitleField = typeRow.titleFieldKey === current.key;
      if (clearsTitleField) {
        await tx
          .update(contentTypes)
          .set({ titleFieldKey: null, updatedAt })
          .where(eq(contentTypes.id, typeRow.id));
      }

      await tx
        .delete(contentTypeFields)
        .where(eq(contentTypeFields.id, current.id));

      return {
        result: undefined,
        after: { fieldKey: current.key, entriesHoldingValue, clearsTitleField },
      };
    },
  );
}
