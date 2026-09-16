/**
 * Content type creation (D-01, D-05): a type's `key` (code-facing) and
 * `slug` (URL-facing) are independent identifiers, generated/validated
 * before the audited mutation runs, then inserted in one transaction with
 * its audit row.
 */
import type {
  AuditActor,
  AuditDatabase,
  AuditTransaction,
} from '@plakboek/auth';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { ContentDeps } from './config.js';
import {
  countEntries,
  type ContentTypeDeleteImpact,
  type ContentTypeKeyRenameImpact,
  type ReferencingField,
} from './impact-reports.js';
import { recordContentTypeKeyChange } from './key-history.js';
import { contentEntries, contentTypeFields, contentTypes } from './schema.js';
import { isNormalizedSlug, normalizeSlug } from './slug.js';
import {
  REVISION_MODES,
  type ContentTypeRecord,
  type RevisionMode,
} from './types.js';

export const TYPE_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;
export const LABEL_MAX_LENGTH = 200;

export type CreateContentTypeInput = {
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
};

export type ContentTypeValidationIssueCode =
  | 'INVALID_KEY'
  | 'EMPTY_LABEL'
  | 'LABEL_TOO_LONG'
  | 'INVALID_SLUG'
  | 'REVISION_MODE_MISMATCH'
  | 'SINGLETON_ROUTABLE';

export type ContentTypeValidationIssue = {
  readonly code: ContentTypeValidationIssueCode;
  readonly field?: string;
  readonly message: string;
};

/** Thrown by `createContentType` with every problem found in `input`,
 * collected before throwing once. */
export class ContentTypeValidationError extends Error {
  readonly issues: readonly ContentTypeValidationIssue[];

  constructor(issues: readonly ContentTypeValidationIssue[]) {
    super(
      [
        '@plakboek/content: invalid content type input:',
        ...issues.map((issue) => issue.message),
      ].join('\n'),
    );
    this.name = 'ContentTypeValidationError';
    this.issues = issues;
  }
}

/** Thrown when `key` or `slug` collides with an existing content type. */
export class ContentTypeConflictError extends Error {
  readonly conflict: 'key' | 'slug';

  constructor(conflict: 'key' | 'slug') {
    super(
      `@plakboek/content: a content type with that ${conflict} already exists`,
    );
    this.name = 'ContentTypeConflictError';
    this.conflict = conflict;
  }
}

const UNIQUE_VIOLATION = '23505';
const KEY_UNIQUE_CONSTRAINT = 'content_types_key_unique';
const SLUG_UNIQUE_CONSTRAINT = 'content_types_slug_unique';
const MAX_CAUSE_DEPTH = 3;

function isRevisionMode(value: string): value is RevisionMode {
  return REVISION_MODES.some((mode) => mode === value);
}

function asRevisionMode(value: string | null): RevisionMode | null {
  if (value === null) return null;
  if (isRevisionMode(value)) return value;
  throw new TypeError(
    `@plakboek/content: unexpected revision_mode "${value}" stored for a content type`,
  );
}

/** Walks the `cause` chain looking for a unique-violation constraint name;
 * returns `undefined` when the failure is not a unique violation this
 * function recognizes. */
function conflictingConstraint(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) break;
    const code = Reflect.get(current, 'code');
    if (code === UNIQUE_VIOLATION) {
      const constraint = Reflect.get(current, 'constraint_name');
      return typeof constraint === 'string' ? constraint : undefined;
    }
    current = current.cause;
  }
  return undefined;
}

function asConflictError(error: unknown): ContentTypeConflictError | undefined {
  const constraint = conflictingConstraint(error);
  if (constraint === KEY_UNIQUE_CONSTRAINT)
    return new ContentTypeConflictError('key');
  if (constraint === SLUG_UNIQUE_CONSTRAINT)
    return new ContentTypeConflictError('slug');
  return undefined;
}

type NormalizedCreateInput = {
  readonly key: string;
  readonly labelSingular: string;
  readonly labelPlural: string;
  readonly slug: string;
  readonly description: string | undefined;
  readonly routable: boolean;
  readonly singleton: boolean;
  readonly drafts: boolean;
  readonly revisions: boolean;
  readonly revisionMode: RevisionMode | undefined;
  readonly editLocking: boolean;
  readonly seo: boolean;
};

function normalizeLabel(value: string): string {
  return value.normalize('NFC').trim();
}

function validateLabel(
  value: string,
  field: string,
  issues: ContentTypeValidationIssue[],
): void {
  if (value.length === 0) {
    issues.push({
      code: 'EMPTY_LABEL',
      field,
      message: `${field} must not be empty or whitespace-only`,
    });
    return;
  }
  if (Array.from(value).length > LABEL_MAX_LENGTH) {
    issues.push({
      code: 'LABEL_TOO_LONG',
      field,
      message: `${field} must be at most ${LABEL_MAX_LENGTH} Unicode code points`,
    });
  }
}

/** Validates and normalizes a `createContentType` input before any audited
 * work runs. Throws `ContentTypeValidationError` once, listing every issue
 * found. */
function normalizeCreateInput(
  input: CreateContentTypeInput,
): NormalizedCreateInput {
  const issues: ContentTypeValidationIssue[] = [];

  if (!TYPE_KEY_PATTERN.test(input.key)) {
    issues.push({
      code: 'INVALID_KEY',
      field: 'key',
      message: `key must match ${TYPE_KEY_PATTERN.source}`,
    });
  }

  const labelSingular = normalizeLabel(input.labelSingular);
  const labelPlural = normalizeLabel(input.labelPlural);
  validateLabel(labelSingular, 'labelSingular', issues);
  validateLabel(labelPlural, 'labelPlural', issues);

  const description =
    input.description === undefined
      ? undefined
      : normalizeLabel(input.description);

  let slug: string;
  if (input.slug !== undefined) {
    const normalizedOverride = normalizeSlug(input.slug);
    if (normalizedOverride.length === 0 || normalizedOverride !== input.slug) {
      issues.push({
        code: 'INVALID_SLUG',
        field: 'slug',
        message: 'slug must already be in normalized form and non-empty',
      });
      slug = normalizedOverride;
    } else {
      slug = normalizedOverride;
    }
  } else {
    slug = normalizeSlug(labelSingular);
    if (slug.length === 0) {
      issues.push({
        code: 'INVALID_SLUG',
        field: 'slug',
        message:
          'labelSingular produced an empty slug; supply an explicit slug',
      });
    }
  }

  const revisions = input.revisions ?? false;
  const revisionModeGiven = input.revisionMode !== undefined;
  if (revisions !== revisionModeGiven) {
    issues.push({
      code: 'REVISION_MODE_MISMATCH',
      field: 'revisionMode',
      message:
        'revisionMode must be set when revisions is true, and omitted otherwise',
    });
  }

  const singleton = input.singleton ?? false;
  const routable = input.routable ?? false;
  if (singleton && routable) {
    issues.push({
      code: 'SINGLETON_ROUTABLE',
      field: 'singleton',
      message: 'a singleton content type cannot also be routable',
    });
  }

  if (issues.length > 0) {
    throw new ContentTypeValidationError(issues);
  }

  return {
    key: input.key,
    labelSingular,
    labelPlural,
    slug,
    description,
    routable,
    singleton,
    drafts: input.drafts ?? false,
    revisions,
    revisionMode: input.revisionMode,
    editLocking: input.editLocking ?? false,
    seo: input.seo ?? false,
  };
}

function toContentTypeRecord(
  row: typeof contentTypes.$inferSelect,
): ContentTypeRecord {
  return {
    id: row.id,
    key: row.key,
    slug: row.slug,
    labelSingular: row.labelSingular,
    labelPlural: row.labelPlural,
    description: row.description,
    routable: row.routable,
    urlPattern: row.urlPattern,
    singleton: row.singleton,
    drafts: row.drafts,
    revisions: row.revisions,
    revisionMode: asRevisionMode(row.revisionMode),
    editLocking: row.editLocking,
    seo: row.seo,
    titleFieldKey: row.titleFieldKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Creates a content type. Validates `input` before any audited work runs
 * (`ContentTypeValidationError`, collected); on success, inserts the row
 * through `deps.recorder.run` (`content-types:create` /
 * `content-type.create`). A `key`/`slug` collision surfaces as
 * `ContentTypeConflictError`.
 */
export async function createContentType(
  deps: ContentDeps,
  actor: AuditActor,
  input: CreateContentTypeInput,
): Promise<ContentTypeRecord> {
  const normalized = normalizeCreateInput(input);
  const now = deps.now ?? (() => new Date());

  try {
    return await deps.recorder.run(
      actor,
      {
        permission: 'content-types:create',
        action: 'content-type.create',
        entityType: 'content_type',
      },
      async (tx) => {
        const createdAt = now();
        const [row] = await tx
          .insert(contentTypes)
          .values({
            key: normalized.key,
            slug: normalized.slug,
            labelSingular: normalized.labelSingular,
            labelPlural: normalized.labelPlural,
            description: normalized.description ?? null,
            routable: normalized.routable,
            singleton: normalized.singleton,
            drafts: normalized.drafts,
            revisions: normalized.revisions,
            revisionMode: normalized.revisionMode ?? null,
            editLocking: normalized.editLocking,
            seo: normalized.seo,
            createdAt,
            updatedAt: createdAt,
          })
          .returning();
        if (row === undefined) {
          throw new Error(
            '@plakboek/content: content type insert returned no row',
          );
        }
        const record = toContentTypeRecord(row);
        return { result: record, after: record };
      },
    );
  } catch (error) {
    const conflict = asConflictError(error);
    if (conflict !== undefined) throw conflict;
    throw error;
  }
}

/** Reads a content type by its code-facing `key`, or `null` when none
 * exists. Not permission-gated: reads are internal API, gated by later
 * phases' HTTP/admin layers. */
export async function getContentTypeByKey(
  db: AuditDatabase,
  key: string,
): Promise<ContentTypeRecord | null> {
  const [row] = await db
    .select()
    .from(contentTypes)
    .where(eq(contentTypes.key, key))
    .limit(1);
  return row === undefined ? null : toContentTypeRecord(row);
}

/** Thrown when turning `drafts` off while an entry of the type still has a
 * pending draft revision (D-11): a drafts-off type has no pending-draft
 * state, so the caller must publish or discard those drafts first. */
export class PendingDraftsError extends Error {
  readonly contentTypeKey: string;
  readonly count: number;

  constructor(contentTypeKey: string, count: number) {
    super(
      `@plakboek/content: content type "${contentTypeKey}" has ${count} entr${count === 1 ? 'y' : 'ies'} with a pending draft revision`,
    );
    this.name = 'PendingDraftsError';
    this.contentTypeKey = contentTypeKey;
    this.count = count;
  }
}

/** Thrown when turning `routable` off while an entry of the type is still
 * published; unpublish (D-48) first. */
export class RoutableInUseError extends Error {
  readonly contentTypeKey: string;
  readonly count: number;

  constructor(contentTypeKey: string, count: number) {
    super(
      `@plakboek/content: content type "${contentTypeKey}" has ${count} published entr${count === 1 ? 'y' : 'ies'}`,
    );
    this.name = 'RoutableInUseError';
    this.contentTypeKey = contentTypeKey;
    this.count = count;
  }
}

/** Thrown when a content type still holds entries (trashed included, D-10)
 * and the caller attempted an operation that requires none: deleting the
 * type, or changing its `singleton` setting. */
export class ContentTypeHasEntriesError extends Error {
  readonly contentTypeKey: string;
  readonly count: number;

  constructor(contentTypeKey: string, count: number) {
    super(
      `@plakboek/content: content type "${contentTypeKey}" has ${count} entr${count === 1 ? 'y' : 'ies'}`,
    );
    this.name = 'ContentTypeHasEntriesError';
    this.contentTypeKey = contentTypeKey;
    this.count = count;
  }
}

/** Thrown by `deleteContentType` when removing the type's key from a
 * referencing field's `allowedTypeKeys` would leave that field with no
 * allowed type left -- an integrity break, refused rather than warned
 * about. */
export class ContentTypeReferencedError extends Error {
  readonly contentTypeKey: string;
  readonly referencingFields: readonly ReferencingField[];

  constructor(
    contentTypeKey: string,
    referencingFields: readonly ReferencingField[],
  ) {
    super(
      [
        `@plakboek/content: content type "${contentTypeKey}" is the only allowed type on:`,
        ...referencingFields.map(
          (field) => `- ${field.contentTypeKey}.${field.path}`,
        ),
      ].join('\n'),
    );
    this.name = 'ContentTypeReferencedError';
    this.contentTypeKey = contentTypeKey;
    this.referencingFields = referencingFields;
  }
}

export type TitleFieldErrorReason =
  | 'NOT_ROUTABLE'
  | 'UNKNOWN_FIELD'
  | 'WRONG_TYPE';

/** Thrown by `setTitleField` when `fieldKey` can't be designated: the type
 * isn't routable, the field doesn't exist on it, or it isn't `short_text`
 * (D-27). */
export class TitleFieldError extends Error {
  readonly reason: TitleFieldErrorReason;

  constructor(reason: TitleFieldErrorReason, message: string) {
    super(`@plakboek/content: ${message}`);
    this.name = 'TitleFieldError';
    this.reason = reason;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One field row that lists `typeKey` among its (possibly nested)
 * `allowedTypeKeys` -- kept richer than `ReferencingField` so
 * `renameContentTypeKey`/`deleteContentType` can rewrite it in place without
 * re-querying. */
type ReferencingFieldRow = {
  readonly fieldId: string;
  readonly fieldType: 'reference' | 'repeater';
  readonly contentTypeKey: string;
  readonly fieldKey: string;
  readonly path: string;
  readonly subFieldKey?: string;
  readonly allowedTypeKeys: readonly string[];
  readonly options: Record<string, unknown>;
};

function toReferencingFieldReport(row: ReferencingFieldRow): ReferencingField {
  return {
    contentTypeKey: row.contentTypeKey,
    fieldKey: row.fieldKey,
    path: row.path,
  };
}

/**
 * Every `reference` field (direct, or a repeater sub-field) across every
 * content type whose `allowedTypeKeys` lists `typeKey`. Fields are fetched
 * in full (there are only ever a handful of fields per type) and filtered in
 * application code -- simpler and just as safe as a `jsonb_path_exists`
 * query for a table this small, and it hands the rename/delete callers back
 * the exact options object they need to rewrite.
 */
async function findReferencingFields(
  db: AuditDatabase,
  typeKey: string,
): Promise<readonly ReferencingFieldRow[]> {
  const rows = await db
    .select({
      fieldId: contentTypeFields.id,
      fieldKey: contentTypeFields.key,
      fieldType: contentTypeFields.fieldType,
      options: contentTypeFields.options,
      contentTypeKey: contentTypes.key,
    })
    .from(contentTypeFields)
    .innerJoin(
      contentTypes,
      eq(contentTypeFields.contentTypeId, contentTypes.id),
    )
    .where(sql`${contentTypeFields.fieldType} IN ('reference', 'repeater')`);

  const referencing: ReferencingFieldRow[] = [];
  for (const row of rows) {
    if (!isPlainObject(row.options)) continue;

    if (row.fieldType === 'reference') {
      const allowedTypeKeys = row.options.allowedTypeKeys;
      if (Array.isArray(allowedTypeKeys) && allowedTypeKeys.includes(typeKey)) {
        referencing.push({
          fieldId: row.fieldId,
          fieldType: 'reference',
          contentTypeKey: row.contentTypeKey,
          fieldKey: row.fieldKey,
          path: row.fieldKey,
          allowedTypeKeys: allowedTypeKeys as readonly string[],
          options: row.options,
        });
      }
      continue;
    }

    const subFields = row.options.fields;
    if (!Array.isArray(subFields)) continue;
    for (const subField of subFields) {
      if (
        !isPlainObject(subField) ||
        subField.fieldType !== 'reference' ||
        typeof subField.key !== 'string' ||
        !isPlainObject(subField.options)
      ) {
        continue;
      }
      const allowedTypeKeys = subField.options.allowedTypeKeys;
      if (Array.isArray(allowedTypeKeys) && allowedTypeKeys.includes(typeKey)) {
        referencing.push({
          fieldId: row.fieldId,
          fieldType: 'repeater',
          contentTypeKey: row.contentTypeKey,
          fieldKey: row.fieldKey,
          path: `${row.fieldKey}.${subField.key}`,
          subFieldKey: subField.key,
          allowedTypeKeys: allowedTypeKeys as readonly string[],
          options: row.options,
        });
      }
    }
  }
  return referencing;
}

/** Renames or removes `oldKey` in an `allowedTypeKeys` list: `newKey`
 * defined renames it in place, `undefined` drops it. */
function rewriteKeyList(
  keys: readonly string[],
  oldKey: string,
  newKey: string | undefined,
): string[] {
  return newKey === undefined
    ? keys.filter((key) => key !== oldKey)
    : keys.map((key) => (key === oldKey ? newKey : key));
}

/**
 * Rewrites every field in `rows` (grouped by field id, so a repeater with
 * more than one matching sub-field is written once, not clobbered by a
 * second write starting from stale options) to rename or remove `oldKey` in
 * its `allowedTypeKeys`. Shared by `renameContentTypeKey` (`newKey` set) and
 * `deleteContentType` (`newKey` `undefined`).
 */
async function rewriteReferencingFields(
  tx: AuditTransaction,
  rows: readonly ReferencingFieldRow[],
  oldKey: string,
  newKey: string | undefined,
): Promise<void> {
  const byFieldId = new Map<string, ReferencingFieldRow[]>();
  for (const row of rows) {
    const existing = byFieldId.get(row.fieldId);
    if (existing === undefined) byFieldId.set(row.fieldId, [row]);
    else existing.push(row);
  }

  for (const [fieldId, group] of byFieldId) {
    const first = group[0];
    if (first === undefined) continue;

    let newOptions: Record<string, unknown>;
    if (first.fieldType === 'reference') {
      newOptions = {
        ...first.options,
        allowedTypeKeys: rewriteKeyList(first.allowedTypeKeys, oldKey, newKey),
      };
    } else {
      const subFieldKeys = new Set(
        group
          .map((row) => row.subFieldKey)
          .filter((key): key is string => key !== undefined),
      );
      const subFields = first.options.fields;
      newOptions = {
        ...first.options,
        fields: Array.isArray(subFields)
          ? subFields.map((subField) => {
              if (
                !isPlainObject(subField) ||
                typeof subField.key !== 'string' ||
                !subFieldKeys.has(subField.key) ||
                !isPlainObject(subField.options)
              ) {
                return subField;
              }
              const existingKeys = subField.options.allowedTypeKeys;
              return {
                ...subField,
                options: {
                  ...subField.options,
                  allowedTypeKeys: rewriteKeyList(
                    Array.isArray(existingKeys)
                      ? (existingKeys as readonly string[])
                      : [],
                    oldKey,
                    newKey,
                  ),
                },
              };
            })
          : subFields,
      };
    }

    await tx
      .update(contentTypeFields)
      .set({ options: newOptions })
      .where(eq(contentTypeFields.id, fieldId));
  }
}

async function countEntriesWithPendingDraft(
  tx: AuditTransaction,
  contentTypeId: string,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(contentEntries)
    .where(
      and(
        eq(contentEntries.contentTypeId, contentTypeId),
        isNotNull(contentEntries.draftRevisionId),
      ),
    );
  return row?.count ?? 0;
}

async function countPublishedEntries(
  tx: AuditTransaction,
  contentTypeId: string,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(contentEntries)
    .where(
      and(
        eq(contentEntries.contentTypeId, contentTypeId),
        eq(contentEntries.status, 'published'),
      ),
    );
  return row?.count ?? 0;
}

export type UpdateContentTypeSettingsInput = {
  readonly key: string;
  readonly labelSingular?: string;
  readonly labelPlural?: string;
  readonly description?: string;
  readonly routable?: boolean;
  readonly singleton?: boolean;
  readonly drafts?: boolean;
  readonly revisions?: boolean;
  readonly revisionMode?: RevisionMode;
  readonly editLocking?: boolean;
  readonly seo?: boolean;
};

/**
 * Changes a content type's labels, description, routable/singleton/drafts/
 * revisions/editLocking/seo settings (TYPE-02, TYPE-04, TYPE-05, TYPE-07,
 * TYPE-08, TYPE-09). Every property is optional -- an omitted one keeps its
 * current value. Locks the type row for the duration of the mutation
 * (`SELECT ... FOR UPDATE`); validates the *effective* (current merged with
 * input) state before writing anything, then checks the integrity rules
 * that need a count: `singleton` changing requires no entries
 * (`ContentTypeHasEntriesError`), `drafts` turning off requires no pending
 * draft (`PendingDraftsError`), `routable` turning off requires no
 * published entry (`RoutableInUseError`). Runs through `deps.recorder.run`
 * (`content-types:edit` / `content-type.update`).
 */
export async function updateContentTypeSettings(
  deps: ContentDeps,
  actor: AuditActor,
  input: UpdateContentTypeSettingsInput,
): Promise<ContentTypeRecord> {
  const now = deps.now ?? (() => new Date());

  return await deps.recorder.run(
    actor,
    {
      permission: 'content-types:edit',
      action: 'content-type.update',
      entityType: 'content_type',
    },
    async (tx) => {
      const [current] = await tx
        .select()
        .from(contentTypes)
        .where(eq(contentTypes.key, input.key))
        .for('update');
      if (current === undefined) {
        throw new Error(
          `@plakboek/content: no content type registered for key "${input.key}"`,
        );
      }

      const issues: ContentTypeValidationIssue[] = [];

      const labelSingular =
        input.labelSingular !== undefined
          ? normalizeLabel(input.labelSingular)
          : current.labelSingular;
      if (input.labelSingular !== undefined) {
        validateLabel(labelSingular, 'labelSingular', issues);
      }
      const labelPlural =
        input.labelPlural !== undefined
          ? normalizeLabel(input.labelPlural)
          : current.labelPlural;
      if (input.labelPlural !== undefined) {
        validateLabel(labelPlural, 'labelPlural', issues);
      }
      const description =
        input.description !== undefined
          ? normalizeLabel(input.description)
          : current.description;

      const effectiveSingleton = input.singleton ?? current.singleton;
      const effectiveRoutable = input.routable ?? current.routable;
      if (effectiveSingleton && effectiveRoutable) {
        issues.push({
          code: 'SINGLETON_ROUTABLE',
          field: 'singleton',
          message: 'a singleton content type cannot also be routable',
        });
      }

      const effectiveRevisions = input.revisions ?? current.revisions;
      let effectiveRevisionMode =
        input.revisionMode ?? asRevisionMode(current.revisionMode);
      if (input.revisions === false) {
        effectiveRevisionMode = null;
      }
      if (effectiveRevisions && effectiveRevisionMode === null) {
        issues.push({
          code: 'REVISION_MODE_MISMATCH',
          field: 'revisionMode',
          message:
            'revisionMode must be set when revisions is true, and omitted otherwise',
        });
      }

      if (issues.length > 0) {
        throw new ContentTypeValidationError(issues);
      }

      if (
        input.singleton !== undefined &&
        input.singleton !== current.singleton
      ) {
        const count = await countEntries(tx, current.id);
        if (count > 0) throw new ContentTypeHasEntriesError(input.key, count);
      }
      if (input.drafts === false) {
        const count = await countEntriesWithPendingDraft(tx, current.id);
        if (count > 0) throw new PendingDraftsError(input.key, count);
      }
      if (input.routable === false) {
        const count = await countPublishedEntries(tx, current.id);
        if (count > 0) throw new RoutableInUseError(input.key, count);
      }

      const updatedAt = now();
      const [row] = await tx
        .update(contentTypes)
        .set({
          labelSingular,
          labelPlural,
          description: description ?? null,
          routable: effectiveRoutable,
          singleton: effectiveSingleton,
          drafts: input.drafts ?? current.drafts,
          revisions: effectiveRevisions,
          revisionMode: effectiveRevisionMode,
          editLocking: input.editLocking ?? current.editLocking,
          seo: input.seo ?? current.seo,
          updatedAt,
        })
        .where(eq(contentTypes.id, current.id))
        .returning();
      if (row === undefined) {
        throw new Error(
          '@plakboek/content: content type settings update returned no row',
        );
      }
      const record = toContentTypeRecord(row);
      return { result: record, after: record };
    },
  );
}

export type SetContentTypeSlugInput = {
  readonly key: string;
  readonly slug: string;
};

/**
 * Changes a content type's URL-facing `slug` (TYPE-02, TYPE-03), leaving its
 * code-facing `key` untouched (D-05). `slug` must already be in normalized
 * form; a slug already used by another content type surfaces as
 * `ContentTypeConflictError('slug')`. Runs through `deps.recorder.run`
 * (`content-types:edit` / `content-type.set-slug`).
 */
export async function setContentTypeSlug(
  deps: ContentDeps,
  actor: AuditActor,
  input: SetContentTypeSlugInput,
): Promise<ContentTypeRecord> {
  if (!isNormalizedSlug(input.slug)) {
    throw new ContentTypeValidationError([
      {
        code: 'INVALID_SLUG',
        field: 'slug',
        message: 'slug must already be in normalized form and non-empty',
      },
    ]);
  }
  const now = deps.now ?? (() => new Date());

  try {
    return await deps.recorder.run(
      actor,
      {
        permission: 'content-types:edit',
        action: 'content-type.set-slug',
        entityType: 'content_type',
      },
      async (tx) => {
        const [current] = await tx
          .select({ id: contentTypes.id })
          .from(contentTypes)
          .where(eq(contentTypes.key, input.key))
          .for('update');
        if (current === undefined) {
          throw new Error(
            `@plakboek/content: no content type registered for key "${input.key}"`,
          );
        }
        const updatedAt = now();
        const [row] = await tx
          .update(contentTypes)
          .set({ slug: input.slug, updatedAt })
          .where(eq(contentTypes.id, current.id))
          .returning();
        if (row === undefined) {
          throw new Error(
            '@plakboek/content: content type slug update returned no row',
          );
        }
        const record = toContentTypeRecord(row);
        return { result: record, after: record };
      },
    );
  } catch (error) {
    const conflict = asConflictError(error);
    if (conflict !== undefined) throw conflict;
    throw error;
  }
}

/** Reports what renaming a content type's key would touch: how many
 * entries it holds (informational only -- a key rename never touches entry
 * data) and which reference fields would be rewritten. Re-run inside
 * `renameContentTypeKey`'s own transaction, so the counts applied always
 * match. */
export async function computeContentTypeKeyRenameImpact(
  db: AuditDatabase,
  key: string,
): Promise<ContentTypeKeyRenameImpact> {
  const current = await getContentTypeByKey(db, key);
  if (current === null) {
    throw new Error(
      `@plakboek/content: no content type registered for key "${key}"`,
    );
  }
  const entryCount = await countEntries(db, current.id);
  const referencingRows = await findReferencingFields(db, key);
  return {
    entryCount,
    referencingFields: referencingRows.map(toReferencingFieldReport),
    bindingsUsingKey: 0,
  };
}

export type RenameContentTypeKeyInput = {
  readonly key: string;
  readonly newKey: string;
};

/**
 * Renames a content type's code-facing `key`, leaving its URL-facing `slug`
 * untouched (D-05). Rewrites the old key to the new one in every
 * referencing reference field's `allowedTypeKeys` (direct fields and
 * repeater sub-fields) and records a `content_type_key_history` row, all in
 * the same transaction as the rename itself. A `newKey` collision surfaces
 * as `ContentTypeConflictError('key')`. Runs through `deps.recorder.run`
 * (`content-types:edit` / `content-type.rename-key`).
 */
export async function renameContentTypeKey(
  deps: ContentDeps,
  actor: AuditActor,
  input: RenameContentTypeKeyInput,
): Promise<ContentTypeRecord> {
  if (!TYPE_KEY_PATTERN.test(input.newKey)) {
    throw new ContentTypeValidationError([
      {
        code: 'INVALID_KEY',
        field: 'newKey',
        message: `newKey must match ${TYPE_KEY_PATTERN.source}`,
      },
    ]);
  }
  const now = deps.now ?? (() => new Date());

  try {
    return await deps.recorder.run(
      actor,
      {
        permission: 'content-types:edit',
        action: 'content-type.rename-key',
        entityType: 'content_type',
      },
      async (tx) => {
        const [current] = await tx
          .select()
          .from(contentTypes)
          .where(eq(contentTypes.key, input.key))
          .for('update');
        if (current === undefined) {
          throw new Error(
            `@plakboek/content: no content type registered for key "${input.key}"`,
          );
        }

        const referencingRows = await findReferencingFields(tx, input.key);
        await rewriteReferencingFields(
          tx,
          referencingRows,
          input.key,
          input.newKey,
        );

        const updatedAt = now();
        const [row] = await tx
          .update(contentTypes)
          .set({ key: input.newKey, updatedAt })
          .where(eq(contentTypes.id, current.id))
          .returning();
        if (row === undefined) {
          throw new Error(
            '@plakboek/content: content type key rename returned no row',
          );
        }

        await recordContentTypeKeyChange(tx, {
          contentTypeId: current.id,
          oldKey: input.key,
          newKey: input.newKey,
          changedBy: actor.userId,
          changedAt: updatedAt,
        });

        const record = toContentTypeRecord(row);
        return {
          result: record,
          after: {
            record,
            referencingFieldsRewritten: referencingRows.length,
          },
        };
      },
    );
  } catch (error) {
    const conflict = asConflictError(error);
    if (conflict !== undefined) throw conflict;
    throw error;
  }
}

export type SetTitleFieldInput = {
  readonly key: string;
  readonly fieldKey: string | null;
};

/**
 * Designates (or, with `fieldKey: null`, clears) a routable content type's
 * title field (D-27): the field must be `short_text` and belong to the
 * type, and the type must be routable, else `TitleFieldError` names why.
 * Runs through `deps.recorder.run` (`content-types:edit` /
 * `content-type.set-title-field`).
 */
export async function setTitleField(
  deps: ContentDeps,
  actor: AuditActor,
  input: SetTitleFieldInput,
): Promise<ContentTypeRecord> {
  const now = deps.now ?? (() => new Date());

  return await deps.recorder.run(
    actor,
    {
      permission: 'content-types:edit',
      action: 'content-type.set-title-field',
      entityType: 'content_type',
    },
    async (tx) => {
      const [current] = await tx
        .select()
        .from(contentTypes)
        .where(eq(contentTypes.key, input.key))
        .for('update');
      if (current === undefined) {
        throw new Error(
          `@plakboek/content: no content type registered for key "${input.key}"`,
        );
      }

      if (input.fieldKey !== null) {
        if (!current.routable) {
          throw new TitleFieldError(
            'NOT_ROUTABLE',
            `content type "${input.key}" is not routable`,
          );
        }
        const [fieldRow] = await tx
          .select({ fieldType: contentTypeFields.fieldType })
          .from(contentTypeFields)
          .where(
            and(
              eq(contentTypeFields.contentTypeId, current.id),
              eq(contentTypeFields.key, input.fieldKey),
            ),
          );
        if (fieldRow === undefined) {
          throw new TitleFieldError(
            'UNKNOWN_FIELD',
            `field "${input.fieldKey}" does not exist on content type "${input.key}"`,
          );
        }
        if (fieldRow.fieldType !== 'short_text') {
          throw new TitleFieldError(
            'WRONG_TYPE',
            `field "${input.fieldKey}" must be a short_text field to be the title field`,
          );
        }
      }

      const updatedAt = now();
      const [row] = await tx
        .update(contentTypes)
        .set({ titleFieldKey: input.fieldKey, updatedAt })
        .where(eq(contentTypes.id, current.id))
        .returning();
      if (row === undefined) {
        throw new Error(
          '@plakboek/content: content type title field update returned no row',
        );
      }
      const record = toContentTypeRecord(row);
      return { result: record, after: record };
    },
  );
}

/** Reports what deleting a content type would touch: how many entries it
 * holds (trashed included, D-10 -- any positive count refuses the delete)
 * and which reference fields still list it. Re-run inside
 * `deleteContentType`'s own transaction, so the counts applied always
 * match. */
export async function computeContentTypeDeleteImpact(
  db: AuditDatabase,
  key: string,
): Promise<ContentTypeDeleteImpact> {
  const current = await getContentTypeByKey(db, key);
  if (current === null) {
    throw new Error(
      `@plakboek/content: no content type registered for key "${key}"`,
    );
  }
  const entryCount = await countEntries(db, current.id);
  const referencingRows = await findReferencingFields(db, key);
  return {
    entryCount,
    referencingFields: referencingRows.map(toReferencingFieldReport),
  };
}

export type DeleteContentTypeInput = { readonly key: string };

/**
 * Deletes a content type (D-10). Refuses with `ContentTypeHasEntriesError`
 * when it holds any entry, trashed included. Otherwise removes the type's
 * key from every referencing reference field's `allowedTypeKeys`; when that
 * would leave a field with an empty list, refuses with
 * `ContentTypeReferencedError` naming those fields instead -- an integrity
 * break, not a warn-and-proceed case. Deletes the type row last (its fields
 * cascade via the FK; seed application rows are untouched, so D-03 never
 * re-creates a deleted seeded type). Runs through `deps.recorder.run`
 * (`content-types:delete` / `content-type.delete`).
 */
export async function deleteContentType(
  deps: ContentDeps,
  actor: AuditActor,
  input: DeleteContentTypeInput,
): Promise<void> {
  await deps.recorder.run(
    actor,
    {
      permission: 'content-types:delete',
      action: 'content-type.delete',
      entityType: 'content_type',
    },
    async (tx) => {
      const [current] = await tx
        .select()
        .from(contentTypes)
        .where(eq(contentTypes.key, input.key))
        .for('update');
      if (current === undefined) {
        throw new Error(
          `@plakboek/content: no content type registered for key "${input.key}"`,
        );
      }

      const entryCount = await countEntries(tx, current.id);
      if (entryCount > 0) {
        throw new ContentTypeHasEntriesError(input.key, entryCount);
      }

      const referencingRows = await findReferencingFields(tx, input.key);
      const emptying = referencingRows.filter(
        (row) => row.allowedTypeKeys.length === 1,
      );
      if (emptying.length > 0) {
        throw new ContentTypeReferencedError(
          input.key,
          emptying.map(toReferencingFieldReport),
        );
      }

      await rewriteReferencingFields(tx, referencingRows, input.key, undefined);

      await tx.delete(contentTypes).where(eq(contentTypes.id, current.id));

      return {
        result: undefined,
        after: {
          entryCount,
          referencingFieldsUpdated: referencingRows.length,
        },
      };
    },
  );
}
