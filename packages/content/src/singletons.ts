/**
 * Singleton content types (TYPE-11, D-22): a type flagged `singleton` holds
 * at most one record per enabled locale, all sharing one translation group,
 * with no slug and no list read. `getOrCreateSingleton` is the only creation
 * path -- `createEntry` and `createTranslation` both refuse a singleton type
 * (see their own `SingletonEntryError` checks), and `listEntries` refuses one
 * too, since a singleton has no list semantics.
 */
import { randomUUID } from 'node:crypto';
import type { AuditActor, AuditDatabase } from '@plakboek/auth';
import { and, eq, sql } from 'drizzle-orm';
import type { ContentConfig, ContentDeps } from './config.js';
import { LocaleNotEnabledError, toEntryRecord } from './entries.js';
import { listFields } from './fields.js';
import { contentEntries, contentTypes } from './schema.js';
import type { EntryRecord } from './types.js';
import { validateEntryData } from './validation.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type SingletonEntryErrorReason = 'not-singleton' | 'singleton-type';

/** Thrown for two distinct singleton misuses (TYPE-11): `'not-singleton'`
 * when `getOrCreateSingleton` is called against a content type that isn't
 * one, and `'singleton-type'` when `createEntry`, `createTranslation` or
 * `listEntries` is called against one that is -- a singleton type has
 * exactly one creation path (`getOrCreateSingleton`) and no list read. */
export class SingletonEntryError extends Error {
  readonly contentTypeKey: string;
  readonly reason: SingletonEntryErrorReason;

  constructor(contentTypeKey: string, reason: SingletonEntryErrorReason) {
    super(
      reason === 'not-singleton'
        ? `@plakboek/content: content type "${contentTypeKey}" is not a singleton`
        : `@plakboek/content: content type "${contentTypeKey}" is a singleton and does not support this operation`,
    );
    this.name = 'SingletonEntryError';
    this.contentTypeKey = contentTypeKey;
    this.reason = reason;
  }
}

export type GetOrCreateSingletonInput = {
  readonly contentTypeKey: string;
  readonly locale: string;
  readonly data?: unknown;
};

/**
 * The only creation path for a singleton content type's records (TYPE-11,
 * D-22). Refuses a disabled locale before the audited mutation opens
 * (`LocaleNotEnabledError`); otherwise, inside `deps.recorder.run`
 * (`entries:create` / `entry.create`): locks the content type row `FOR
 * UPDATE` for the duration of the mutation -- this single lock is what makes
 * two concurrent calls for the same type and locale produce exactly one row
 * (T-03-53), since the second call blocks until the first commits and then
 * finds the row the first call already inserted -- refuses a non-singleton
 * type (`SingletonEntryError`, `'not-singleton'`), and returns the existing
 * row for `input.locale` unchanged when one already exists (no insert).
 * Otherwise builds the new row's data the same way `createTranslation` does:
 * when another locale of the type already has a row, a shared
 * (non-translatable) field's value is copied from it and `input.data`'s
 * value is taken for every translatable field; when this is the type's
 * first locale, `input.data` is used directly. Validates the merged data
 * (FIELD-06) and inserts a `draft` row with a `null` slug, sharing the
 * existing group's `translation_group`/`public_id` or starting a fresh one.
 */
export async function getOrCreateSingleton(
  deps: ContentDeps,
  actor: AuditActor,
  input: GetOrCreateSingletonInput,
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
        .select()
        .from(contentTypes)
        .where(eq(contentTypes.key, input.contentTypeKey))
        .for('update');
      if (typeRow === undefined) {
        throw new Error(
          `@plakboek/content: no content type registered for key "${input.contentTypeKey}"`,
        );
      }
      if (!typeRow.singleton) {
        throw new SingletonEntryError(input.contentTypeKey, 'not-singleton');
      }

      const existingRows = await tx
        .select()
        .from(contentEntries)
        .where(eq(contentEntries.contentTypeId, typeRow.id));

      const existingForLocale = existingRows.find(
        (row) => row.locale === input.locale,
      );
      if (existingForLocale !== undefined) {
        const record = toEntryRecord(existingForLocale);
        return { result: record, after: record };
      }

      const fields = await listFields(tx, typeRow.id);
      const inputData = isPlainObject(input.data) ? input.data : {};
      const anotherRow = existingRows[0];

      let merged: Record<string, unknown>;
      if (anotherRow !== undefined) {
        merged = {};
        for (const field of fields) {
          if (field.translatable) {
            if (Object.hasOwn(inputData, field.key)) {
              merged[field.key] = inputData[field.key];
            }
          } else if (Object.hasOwn(anotherRow.data, field.key)) {
            merged[field.key] = anotherRow.data[field.key];
          }
        }
      } else {
        merged = inputData;
      }

      const validated = validateEntryData(fields, merged);

      const createdAt = now();
      const [row] = await tx
        .insert(contentEntries)
        .values({
          contentTypeId: typeRow.id,
          translationGroup: anotherRow?.translationGroup ?? randomUUID(),
          publicId:
            anotherRow?.publicId ?? sql`nextval('content_entry_public_id_seq')`,
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
        throw new Error(
          '@plakboek/content: singleton entry insert returned no row',
        );
      }
      const record = toEntryRecord(row);
      return { result: record, after: record };
    },
  );
}

/** Reads a content type's internal id and `singleton` flag by its
 * code-facing key, without locking anything -- the read-side helper shared
 * by `findSingleton`/`listSingletonRecords`. */
async function getSingletonTypeId(
  db: AuditDatabase,
  contentTypeKey: string,
): Promise<string | null> {
  const [typeRow] = await db
    .select({ id: contentTypes.id })
    .from(contentTypes)
    .where(eq(contentTypes.key, contentTypeKey))
    .limit(1);
  return typeRow?.id ?? null;
}

export type FindSingletonInput = {
  readonly contentTypeKey: string;
  readonly locale: string;
};

/**
 * Reads a singleton content type's record for one locale (TYPE-11). Returns
 * `null` before a record exists for that locale, for an unregistered
 * `contentTypeKey`, and -- never a row -- for a locale no longer enabled in
 * `config.locales` (D-25's read exclusion applies to singleton reads too).
 * Not permission-gated: reads are internal API, gated by later phases'
 * HTTP/admin layers.
 */
export async function findSingleton(
  db: AuditDatabase,
  config: ContentConfig,
  input: FindSingletonInput,
): Promise<EntryRecord | null> {
  if (!config.locales.includes(input.locale)) return null;

  const typeId = await getSingletonTypeId(db, input.contentTypeKey);
  if (typeId === null) return null;

  const [row] = await db
    .select()
    .from(contentEntries)
    .where(
      and(
        eq(contentEntries.contentTypeId, typeId),
        eq(contentEntries.locale, input.locale),
      ),
    )
    .limit(1);
  return row === undefined ? null : toEntryRecord(row);
}

export type ListSingletonRecordsInput = {
  readonly contentTypeKey: string;
};

/**
 * Lists a singleton content type's records, one per enabled locale that has
 * one, ordered by that locale's index in `config.locales` (TYPE-11 ordering)
 * -- never insertion order. A locale removed from `config.locales` is
 * excluded, matching every other host-facing read (D-25). Not
 * permission-gated.
 */
export async function listSingletonRecords(
  db: AuditDatabase,
  config: ContentConfig,
  input: ListSingletonRecordsInput,
): Promise<readonly EntryRecord[]> {
  const typeId = await getSingletonTypeId(db, input.contentTypeKey);
  if (typeId === null) return [];

  const rows = await db
    .select()
    .from(contentEntries)
    .where(eq(contentEntries.contentTypeId, typeId));

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
