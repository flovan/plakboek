/**
 * Collect-all entry data validation (FIELD-06, D-12): every field rule runs
 * on every save, drafts included, and every issue is collected before
 * throwing once -- following `@plakboek/permissions`'s `RoleConfigError`
 * shape. `createEntry` and `saveEntry` call this before writing anything;
 * there is no bypass flag and no raw update helper that skips it.
 */
import {
  getFieldTypeDefinition,
  parseFieldOptions,
} from './field-types/registry.js';
import type { FieldDefinition } from './types.js';

export type FieldValidationIssueCode =
  | 'REQUIRED'
  | 'INVALID_VALUE'
  | 'UNKNOWN_FIELD'
  | 'INVALID_DATA';

export type FieldValidationIssue = {
  readonly code: FieldValidationIssueCode;
  readonly fieldKey: string;
  readonly path: readonly (string | number)[];
  readonly message: string;
};

/** Thrown by `validateEntryData` with every issue found, collected before
 * throwing once. The message names each issue's field key and code only --
 * never the submitted value (T-02-06-style redaction discipline). */
export class FieldValidationError extends Error {
  readonly issues: readonly FieldValidationIssue[];

  constructor(issues: readonly FieldValidationIssue[]) {
    super(
      [
        '@plakboek/content: entry data failed validation',
        ...issues.map((issue) => `- ${issue.fieldKey} (${issue.code})`),
      ].join('\n'),
    );
    this.name = 'FieldValidationError';
    this.issues = issues;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Zod issue paths carry `PropertyKey` segments (string | number | symbol);
 * `FieldValidationIssue.path` only ever holds string/number, so a rare
 * symbol segment is stringified rather than cast. */
function toPathSegment(segment: PropertyKey): string | number {
  return typeof segment === 'number' ? segment : String(segment);
}

/**
 * Validates `data` against `fields` (a content type's field definitions).
 * Every field rule -- required, shape, and every other value-schema check --
 * is enforced. Returns a new object holding only the keys that validated,
 * in `sortOrder`; throws `FieldValidationError` once, listing every issue
 * found, if any field fails.
 */
export function validateEntryData(
  fields: readonly FieldDefinition[],
  data: unknown,
): Readonly<Record<string, unknown>> {
  if (!isPlainObject(data)) {
    throw new FieldValidationError([
      {
        code: 'INVALID_DATA',
        fieldKey: '',
        path: [],
        message: 'entry data must be a plain object',
      },
    ]);
  }

  const issues: FieldValidationIssue[] = [];
  const fieldKeys = new Set(fields.map((field) => field.key));

  for (const key of Object.keys(data)) {
    if (!fieldKeys.has(key)) {
      issues.push({
        code: 'UNKNOWN_FIELD',
        fieldKey: key,
        path: [key],
        message: `"${key}" does not match any field on this content type`,
      });
    }
  }

  const sortedFields = [...fields].sort((a, b) => a.sortOrder - b.sortOrder);
  const result: Record<string, unknown> = {};

  for (const field of sortedFields) {
    const definition = getFieldTypeDefinition(field.fieldType);
    const value = data[field.key];

    if (definition.isEmptyValue(value)) {
      if (field.required) {
        issues.push({
          code: 'REQUIRED',
          fieldKey: field.key,
          path: [field.key],
          message: `"${field.key}" is required`,
        });
      }
      continue;
    }

    const options = parseFieldOptions(field.fieldType, field.options);
    const parsed = definition.buildValueSchema(options).safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({
          code: 'INVALID_VALUE',
          fieldKey: field.key,
          path: [field.key, ...issue.path.map(toPathSegment)],
          message: issue.message,
        });
      }
      continue;
    }

    result[field.key] = parsed.data;
  }

  if (issues.length > 0) {
    throw new FieldValidationError(issues);
  }

  return Object.freeze(result);
}
