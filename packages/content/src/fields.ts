/**
 * Adding a field to a content type (D-01, D-06): no dynamic DDL -- a field
 * is a row in `content_type_fields`, never a schema-altering statement. The
 * content type row is locked (`SELECT ... FOR UPDATE`) for the duration of
 * the mutation so two concurrent schema edits on the same type serialize.
 */
import type { AuditActor, AuditDatabase } from '@plakboek/auth';
import { asc, eq, sql } from 'drizzle-orm';
import type { ContentDeps } from './config.js';
import {
  FieldDefinitionError,
  getFieldTypeDefinition,
  isFieldType,
  parseFieldOptions,
  type FieldType,
} from './field-types/registry.js';
import { contentTypeFields, contentTypes } from './schema.js';
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
        return { result: record, after: record };
      },
    );
  } catch (error) {
    if (isUniqueViolationOn(error, FIELD_TYPE_KEY_UNIQUE_CONSTRAINT)) {
      throw new FieldKeyConflictError(key);
    }
    throw error;
  }
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
