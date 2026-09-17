/**
 * Starting a translation (D-21, I18N-04): any enabled locale can start a
 * group -- `createEntry` already does that (03-02) -- and `createTranslation`
 * adds another enabled locale to an existing group, copying the source
 * row's non-translatable values and taking the input's translatable values
 * for the rest. The group is locked in locale order first
 * (`lockTranslationGroupForUpdate`), so a concurrent translation of the same
 * group serializes rather than racing past the "locale already present"
 * check.
 */
import type { AuditActor } from '@plakboek/auth';
import type { ContentDeps } from './config.js';
import {
  LocaleNotEnabledError,
  lockTranslationGroupForUpdate,
  toEntryRecord,
} from './entries.js';
import { listFields } from './fields.js';
import { contentEntries } from './schema.js';
import type { EntryRecord } from './types.js';
import { validateEntryData } from './validation.js';

const UNIQUE_VIOLATION = '23505';
const GROUP_LOCALE_UNIQUE_CONSTRAINT = 'content_entries_group_locale_unique';
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Thrown by `createTranslation` when `input.locale` already has a row in
 * the source entry's translation group. */
export class TranslationExistsError extends Error {
  readonly translationGroup: string;
  readonly locale: string;

  constructor(translationGroup: string, locale: string) {
    super(
      `@plakboek/content: translation group "${translationGroup}" already has a row for locale "${locale}"`,
    );
    this.name = 'TranslationExistsError';
    this.translationGroup = translationGroup;
    this.locale = locale;
  }
}

export type CreateTranslationInput = {
  readonly sourceEntryId: string;
  readonly locale: string;
  readonly data?: unknown;
};

/**
 * Adds `input.locale` to `input.sourceEntryId`'s translation group (D-21,
 * I18N-04). Refuses a disabled locale before the audited mutation opens
 * (`LocaleNotEnabledError`); otherwise, inside `deps.recorder.run`
 * (`entries:create` / `entry.create-translation`): locks the group in locale
 * order (`lockTranslationGroupForUpdate`, which also throws
 * `EntryNotFoundError` for a missing source entry), refuses an existing row
 * for `input.locale` (`TranslationExistsError`), then builds the new row's
 * data from the source row's non-translatable field values (D-19: a shared
 * field always mirrors the source, regardless of what `input.data` carries
 * for it) plus `input.data`'s value for every translatable field, validates
 * it (FIELD-06), and inserts a new `draft` row sharing the source's
 * `content_type_id`, `translation_group` and `public_id`, with a fresh
 * `version` of 1 and no slug. A unique-violation race on
 * `content_entries_group_locale_unique` is mapped to the same
 * `TranslationExistsError`.
 */
export async function createTranslation(
  deps: ContentDeps,
  actor: AuditActor,
  input: CreateTranslationInput,
): Promise<EntryRecord> {
  if (!deps.config.locales.includes(input.locale)) {
    throw new LocaleNotEnabledError(input.locale);
  }
  const now = deps.now ?? (() => new Date());

  return await deps.recorder.run(
    actor,
    {
      permission: 'entries:create',
      action: 'entry.create-translation',
      entityType: 'content_entry',
    },
    async (tx) => {
      const { origin, rows } = await lockTranslationGroupForUpdate(
        tx,
        input.sourceEntryId,
      );

      const existing = rows.find((row) => row.locale === input.locale);
      if (existing !== undefined) {
        throw new TranslationExistsError(origin.translationGroup, input.locale);
      }

      const fields = await listFields(tx, origin.contentTypeId);
      const inputData = isPlainObject(input.data) ? input.data : {};

      const merged: Record<string, unknown> = {};
      for (const field of fields) {
        if (field.translatable) {
          if (Object.hasOwn(inputData, field.key)) {
            merged[field.key] = inputData[field.key];
          }
        } else if (Object.hasOwn(origin.data, field.key)) {
          merged[field.key] = origin.data[field.key];
        }
      }

      const validated = validateEntryData(fields, merged);

      const createdAt = now();
      let row: typeof contentEntries.$inferSelect | undefined;
      try {
        [row] = await tx
          .insert(contentEntries)
          .values({
            contentTypeId: origin.contentTypeId,
            translationGroup: origin.translationGroup,
            publicId: origin.publicId,
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
      } catch (error) {
        if (isUniqueViolationOn(error, GROUP_LOCALE_UNIQUE_CONSTRAINT)) {
          throw new TranslationExistsError(
            origin.translationGroup,
            input.locale,
          );
        }
        throw error;
      }
      if (row === undefined) {
        throw new Error(
          '@plakboek/content: translation insert returned no row',
        );
      }
      const record = toEntryRecord(row);
      return { result: record, after: record };
    },
  );
}
