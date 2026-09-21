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
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { ContentConfig, ContentDeps } from './config.js';
import { listFields } from './fields.js';
import { contentEntries, contentTypes } from './schema.js';
import { SingletonEntryError } from './singletons.js';
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
        .select({ id: contentTypes.id, singleton: contentTypes.singleton })
        .from(contentTypes)
        .where(eq(contentTypes.key, input.contentTypeKey))
        .for('share');
      if (typeRow === undefined) {
        throw new Error(
          `@plakboek/content: no content type registered for key "${input.contentTypeKey}"`,
        );
      }
      if (typeRow.singleton) {
        throw new SingletonEntryError(input.contentTypeKey, 'singleton-type');
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
 * `EntryNotFoundError` when no row matches, and `LocaleNotEnabledError` when
 * the row's own locale is no longer in `config.locales` -- a row of a
 * removed locale is refused for every write (D-25, plan 03-11). */
export async function loadEntryForUpdate(
  tx: AuditTransaction,
  config: ContentConfig,
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
  if (!config.locales.includes(row.locale)) {
    throw new LocaleNotEnabledError(row.locale);
  }
  return toEntryRecord(row);
}

/**
 * Locks every row of `entryId`'s translation group -- the group is found by
 * a subquery on `entryId`'s own `translation_group`, and every row of it is
 * locked `ORDER BY locale FOR UPDATE` (plan 03-10). Two saves from different
 * locales of the same group therefore always request row locks in the same
 * order, so they can never deadlock against each other. Throws
 * `EntryNotFoundError` when `entryId` doesn't exist, and
 * `LocaleNotEnabledError` when the origin row's own locale is no longer in
 * `config.locales` -- a row of a removed locale is refused for every write
 * (D-25, plan 03-11); a sibling of a removed locale is simply excluded by
 * each caller's own sibling filtering (unaffected here). Returns the row
 * matching `entryId` as `origin` and every row of the group -- `origin`
 * included -- as `rows`.
 */
export async function lockTranslationGroupForUpdate(
  tx: AuditTransaction,
  config: ContentConfig,
  entryId: string,
): Promise<{
  readonly origin: EntryRecord;
  readonly rows: readonly EntryRecord[];
}> {
  const groupRows = await tx
    .select()
    .from(contentEntries)
    .where(
      sql`${contentEntries.translationGroup} = (SELECT translation_group FROM content_entries WHERE id = ${entryId})`,
    )
    .orderBy(asc(contentEntries.locale))
    .for('update');

  const records = groupRows.map(toEntryRecord);
  const origin = records.find((record) => record.id === entryId);
  if (origin === undefined) {
    throw new EntryNotFoundError(entryId);
  }
  if (!config.locales.includes(origin.locale)) {
    throw new LocaleNotEnabledError(origin.locale);
  }
  return { origin, rows: records };
}

export type FindEntryInput = { readonly entryId: string };

/** Reads one entry by id, excluding a row whose locale is no longer enabled
 * in `config.locales` (D-25) -- returns `null` for that case, the same as a
 * missing row. Not permission-gated: reads are internal API, gated by later
 * phases' HTTP/admin layers. */
export async function findEntry(
  db: AuditDatabase,
  config: ContentConfig,
  input: FindEntryInput,
): Promise<EntryRecord | null> {
  const entry = await getEntry(db, input.entryId);
  if (entry === null) return null;
  if (!config.locales.includes(entry.locale)) return null;
  return entry;
}

export type FindTranslationsInput = { readonly translationGroup: string };

/** Reads every row of a translation group, excluding rows of a locale no
 * longer enabled in `config.locales` (D-25), ordered by that locale's index
 * in `config.locales`. Not permission-gated. */
export async function findTranslations(
  db: AuditDatabase,
  config: ContentConfig,
  input: FindTranslationsInput,
): Promise<readonly EntryRecord[]> {
  const rows = await db
    .select()
    .from(contentEntries)
    .where(eq(contentEntries.translationGroup, input.translationGroup));

  const records = rows
    .map(toEntryRecord)
    .filter((record) => config.locales.includes(record.locale));
  return records
    .slice()
    .sort(
      (a, b) =>
        config.locales.indexOf(a.locale) - config.locales.indexOf(b.locale),
    );
}

export type ListEntriesInput = {
  readonly contentTypeKey: string;
  readonly locale: string;
  readonly statuses?: readonly EntryStatus[];
  readonly includeTrashed?: boolean;
};

/**
 * Lists a content type's entries in one locale (I18N-04, RESEARCH.md Pitfall
 * 1: every list read takes a required locale, there is no "every locale"
 * default). Throws `LocaleNotEnabledError` for a locale not in
 * `config.locales`, and `SingletonEntryError` (`'singleton-type'`) for a
 * singleton content type -- a singleton has no list read (TYPE-11).
 * Excludes `trashed` entries unless `input.includeTrashed` is `true`; when
 * `input.statuses` is given, only those statuses are returned (still subject
 * to the trashed exclusion above). Ordered `created_at ASC, id ASC` (TYPE-10
 * ordering), so entries sharing a timestamp come back in a stable order. Not
 * permission-gated.
 */
export async function listEntries(
  db: AuditDatabase,
  config: ContentConfig,
  input: ListEntriesInput,
): Promise<readonly EntryRecord[]> {
  if (!config.locales.includes(input.locale)) {
    throw new LocaleNotEnabledError(input.locale);
  }

  const [typeRow] = await db
    .select({ id: contentTypes.id, singleton: contentTypes.singleton })
    .from(contentTypes)
    .where(eq(contentTypes.key, input.contentTypeKey))
    .limit(1);
  if (typeRow === undefined) {
    throw new Error(
      `@plakboek/content: no content type registered for key "${input.contentTypeKey}"`,
    );
  }
  if (typeRow.singleton) {
    throw new SingletonEntryError(input.contentTypeKey, 'singleton-type');
  }

  const conditions = [
    eq(contentEntries.contentTypeId, typeRow.id),
    eq(contentEntries.locale, input.locale),
  ];
  if (input.includeTrashed !== true) {
    conditions.push(sql`${contentEntries.status} <> 'trashed'`);
  }
  if (input.statuses !== undefined) {
    conditions.push(inArray(contentEntries.status, input.statuses));
  }

  const rows = await db
    .select()
    .from(contentEntries)
    .where(and(...conditions))
    .orderBy(asc(contentEntries.createdAt), asc(contentEntries.id));
  return rows.map(toEntryRecord);
}
