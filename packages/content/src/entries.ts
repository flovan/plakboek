/**
 * Entry creation and the row-loading primitives `save.ts` builds on
 * (D-42/D-47). Every read that touches `content_entries` takes `locale` (or
 * loads a single already-located row) -- there is no "every locale" default
 * (Pitfall 1).
 */
import { randomUUID } from 'node:crypto';
import type {
  AuditActor,
  AuditDatabase,
  AuditTransaction,
} from '@plakboek/auth';
import { eq, sql } from 'drizzle-orm';
import type { ContentDeps } from './config.js';
import { listFields } from './fields.js';
import { contentEntries, contentTypes } from './schema.js';
import { ENTRY_STATUSES, type EntryRecord, type EntryStatus } from './types.js';
import { validateEntryData } from './validation.js';

export type CreateEntryInput = {
  readonly contentTypeKey: string;
  readonly locale: string;
  readonly data?: unknown;
};

/** Thrown when `locale` is not one of `ContentDeps.config.locales`. */
export class LocaleNotEnabledError extends Error {
  readonly locale: string;

  constructor(locale: string) {
    super(
      `@plakboek/content: locale "${locale}" is not enabled in ContentConfig`,
    );
    this.name = 'LocaleNotEnabledError';
    this.locale = locale;
  }
}

/** Thrown by `loadEntryForUpdate` when no row matches `entryId`. */
export class EntryNotFoundError extends Error {
  readonly entryId: string;

  constructor(entryId: string) {
    super(`@plakboek/content: no entry found for id "${entryId}"`);
    this.name = 'EntryNotFoundError';
    this.entryId = entryId;
  }
}

function isEntryStatus(value: string): value is EntryStatus {
  return ENTRY_STATUSES.some((status) => status === value);
}

function asEntryStatus(value: string): EntryStatus {
  if (isEntryStatus(value)) return value;
  throw new TypeError(
    `@plakboek/content: unexpected status "${value}" stored for an entry`,
  );
}

/** Maps a stored row to its public `EntryRecord` shape (TYPE-10). Exported
 * so `save.ts` and future entry operations share one conversion. */
export function toEntryRecord(
  row: typeof contentEntries.$inferSelect,
): EntryRecord {
  return {
    id: row.id,
    contentTypeId: row.contentTypeId,
    translationGroup: row.translationGroup,
    publicId: row.publicId,
    locale: row.locale,
    slug: row.slug,
    status: asEntryStatus(row.status),
    data: row.data,
    seo: row.seo,
    version: row.version,
    draftRevisionId: row.draftRevisionId,
    liveRevisionId: row.liveRevisionId,
    resolvedPath: row.resolvedPath,
    lockedBy: row.lockedBy,
    lockedAt: row.lockedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
    firstPublishedAt: row.firstPublishedAt,
    scheduledAt: row.scheduledAt,
    trashedAt: row.trashedAt,
  };
}

/**
 * Creates a draft entry in `input.locale` with a fresh `translation_group`
 * and the next `public_id` (TYPE-06's `{id}` URL token). `input.data` is
 * validated against the content type's fields before anything is written
 * (FIELD-06, D-12) -- an unenabled locale is rejected before any audited
 * work runs. Runs through `deps.recorder.run` (`entries:create` /
 * `entry.create`).
 */
export async function createEntry(
  deps: ContentDeps,
  actor: AuditActor,
  input: CreateEntryInput,
): Promise<EntryRecord> {
  if (!deps.config.locales.includes(input.locale)) {
    throw new LocaleNotEnabledError(input.locale);
  }
  const now = deps.now ?? (() => new Date());

  return await deps.recorder.run(
    actor,
    {
      permission: 'entries:create',
      action: 'entry.create',
      entityType: 'content_entry',
    },
    async (tx) => {
      const [typeRow] = await tx
        .select({ id: contentTypes.id })
        .from(contentTypes)
        .where(eq(contentTypes.key, input.contentTypeKey))
        .for('share');
      if (typeRow === undefined) {
        throw new Error(
          `@plakboek/content: no content type registered for key "${input.contentTypeKey}"`,
        );
      }

      const fields = await listFields(tx, typeRow.id);
      const validated = validateEntryData(fields, input.data ?? {});

      const createdAt = now();
      const [row] = await tx
        .insert(contentEntries)
        .values({
          contentTypeId: typeRow.id,
          translationGroup: randomUUID(),
          publicId: sql`nextval('content_entry_public_id_seq')`,
          locale: input.locale,
          status: 'draft',
          data: validated,
          version: 1,
          createdBy: actor.userId,
          updatedBy: actor.userId,
          createdAt,
          updatedAt: createdAt,
        })
        .returning();
      if (row === undefined) {
        throw new Error('@plakboek/content: entry insert returned no row');
      }
      const record = toEntryRecord(row);
      return { result: record, after: record };
    },
  );
}

/** Reads one entry by id, or `null` when none exists. Not permission-gated:
 * reads are internal API, gated by later phases' HTTP/admin layers. */
export async function getEntry(
  db: AuditDatabase,
  entryId: string,
): Promise<EntryRecord | null> {
  const [row] = await db
    .select()
    .from(contentEntries)
    .where(eq(contentEntries.id, entryId))
    .limit(1);
  return row === undefined ? null : toEntryRecord(row);
}

/** Loads and locks one entry row (`SELECT ... FOR UPDATE`) inside an
 * audited mutation's transaction, for `saveEntry`'s version check. Throws
 * `EntryNotFoundError` when no row matches. */
export async function loadEntryForUpdate(
  tx: AuditTransaction,
  entryId: string,
): Promise<EntryRecord> {
  const [row] = await tx
    .select()
    .from(contentEntries)
    .where(eq(contentEntries.id, entryId))
    .for('update');
  if (row === undefined) {
    throw new EntryNotFoundError(entryId);
  }
  return toEntryRecord(row);
}
