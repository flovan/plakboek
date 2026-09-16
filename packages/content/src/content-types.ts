/**
 * Content type creation (D-01, D-05): a type's `key` (code-facing) and
 * `slug` (URL-facing) are independent identifiers, generated/validated
 * before the audited mutation runs, then inserted in one transaction with
 * its audit row.
 */
import type { AuditActor, AuditDatabase } from '@plakboek/auth';
import { eq } from 'drizzle-orm';
import type { ContentDeps } from './config.js';
import { contentTypes } from './schema.js';
import { normalizeSlug } from './slug.js';
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
