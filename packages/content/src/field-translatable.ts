/**
 * Toggling a field's `translatable` flag on a type already holding data
 * (D-23): turning it on is a pure flag flip -- every row already holds its
 * own copy of the value. Turning it off picks one winner value per
 * translation group (the default locale's value, or the first locale
 * holding one, in `ContentConfig`'s own locale order) and writes it to every
 * other enabled-locale row of the group that differs, in the same
 * transaction as the flag change, reusing `save.ts`'s `applySyncedFieldChanges`
 * so each row's own draft-or-live branch and revision recording behave
 * exactly like a shared-field save (plan 03-10, Task 1).
 */
import type { AuditActor, AuditDatabase } from '@plakboek/auth';
import { eq } from 'drizzle-orm';
import type { ContentConfig, ContentDeps } from './config.js';
import { getContentTypeByKey } from './content-types.js';
import { lockTranslationGroupForUpdate } from './entries.js';
import { getFieldTypeDefinition } from './field-types/registry.js';
import { listFields } from './fields.js';
import { readWorkingCopy } from './publish.js';
import { pruneSaveRevisions } from './revisions.js';
import { applySyncedFieldChanges } from './save.js';
import { contentEntries, contentTypeFields, contentTypes } from './schema.js';
import { getRevisionCap } from './settings.js';
import type { FieldDefinition } from './types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Mirrors `save.ts`'s own structural-equality helper: two `undefined`s are
 * equal, any other mismatched pair involving one is not, everything else
 * compares by serialized shape. */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Reads one row's own working copy value for `fieldKey` (its pending draft
 * when one is staged, its live data otherwise) -- the same draft-or-live
 * rule `save.ts`'s shared-field sync reads from. */
async function readWorkingValue(
  db: AuditDatabase,
  entryId: string,
  fieldKey: string,
): Promise<unknown> {
  const workingCopy = await readWorkingCopy(db, entryId);
  const data = isPlainObject(workingCopy.data) ? workingCopy.data : {};
  return data[fieldKey];
}

export type TranslatableChangeImpactGroup = {
  readonly translationGroup: string;
  readonly winnerLocale: string | null;
  readonly differingLocales: readonly string[];
};

export type TranslatableChangeImpact = {
  readonly groupsAffected: number;
  readonly groups: readonly TranslatableChangeImpactGroup[];
};

type GroupPlan = {
  readonly translationGroup: string;
  readonly anyEntryId: string;
  readonly winnerLocale: string | null;
  readonly winnerValue: unknown;
  readonly differingLocales: readonly string[];
};

/**
 * The per-group work turning `field.key` non-translatable would do: reads
 * every enabled-locale row's own working copy value for the field, picks
 * the winner (the default locale's value if non-empty, else the configured
 * locale order, else -- for a locale outside `config.locales` entirely --
 * alphabetically), and lists every other locale whose value differs from
 * it. Only groups with at least one differing locale are returned. Shared
 * by `computeTranslatableChangeImpact` (the read-only preview) and
 * `setFieldTranslatable` (which recomputes this same plan inside its own
 * transaction before applying it, so the two can never disagree).
 */
async function computeGroupPlans(
  db: AuditDatabase,
  config: ContentConfig,
  contentTypeId: string,
  field: FieldDefinition,
): Promise<GroupPlan[]> {
  const rows = await db
    .select({
      id: contentEntries.id,
      translationGroup: contentEntries.translationGroup,
      locale: contentEntries.locale,
    })
    .from(contentEntries)
    .where(eq(contentEntries.contentTypeId, contentTypeId));

  const enabledRows = rows.filter((row) => config.locales.includes(row.locale));

  const byGroup = new Map<string, typeof enabledRows>();
  for (const row of enabledRows) {
    const list = byGroup.get(row.translationGroup);
    if (list === undefined) byGroup.set(row.translationGroup, [row]);
    else list.push(row);
  }

  const definition = getFieldTypeDefinition(field.fieldType);
  const localeOrder = [
    config.defaultLocale,
    ...config.locales.filter((locale) => locale !== config.defaultLocale),
  ];

  const plans: GroupPlan[] = [];
  for (const [translationGroup, groupRows] of byGroup) {
    const firstRow = groupRows[0];
    if (firstRow === undefined) continue;

    const valuesByLocale = new Map<string, unknown>();
    for (const row of groupRows) {
      valuesByLocale.set(
        row.locale,
        await readWorkingValue(db, row.id, field.key),
      );
    }

    let winnerLocale: string | null = null;
    for (const locale of localeOrder) {
      if (!valuesByLocale.has(locale)) continue;
      if (!definition.isEmptyValue(valuesByLocale.get(locale))) {
        winnerLocale = locale;
        break;
      }
    }
    if (winnerLocale === null) {
      const remaining = [...valuesByLocale.keys()]
        .filter((locale) => !localeOrder.includes(locale))
        .sort();
      for (const locale of remaining) {
        if (!definition.isEmptyValue(valuesByLocale.get(locale))) {
          winnerLocale = locale;
          break;
        }
      }
    }

    const winnerValue =
      winnerLocale === null ? undefined : valuesByLocale.get(winnerLocale);
    const differingLocales = [...valuesByLocale.entries()]
      .filter(
        ([locale, value]) =>
          locale !== winnerLocale && !valuesEqual(value, winnerValue),
      )
      .map(([locale]) => locale)
      .sort();

    if (differingLocales.length > 0) {
      plans.push({
        translationGroup,
        anyEntryId: firstRow.id,
        winnerLocale,
        winnerValue,
        differingLocales,
      });
    }
  }
  return plans;
}

/**
 * Previews what turning `input.translatable` to `false` on
 * `input.contentTypeKey`.`input.fieldKey` would do (D-23): `true` always
 * reports zero groups (turning a field back on rewrites nothing -- every
 * row already holds its own copy). Read-only.
 */
export async function computeTranslatableChangeImpact(
  db: AuditDatabase,
  config: ContentConfig,
  input: {
    readonly contentTypeKey: string;
    readonly fieldKey: string;
    readonly translatable: boolean;
  },
): Promise<TranslatableChangeImpact> {
  if (input.translatable) {
    return { groupsAffected: 0, groups: [] };
  }

  const type = await getContentTypeByKey(db, input.contentTypeKey);
  if (type === null) {
    throw new Error(
      `@plakboek/content: no content type registered for key "${input.contentTypeKey}"`,
    );
  }
  const fields = await listFields(db, type.id);
  const field = fields.find((candidate) => candidate.key === input.fieldKey);
  if (field === undefined) {
    throw new Error(
      `@plakboek/content: no field "${input.fieldKey}" on content type "${input.contentTypeKey}"`,
    );
  }

  const plans = await computeGroupPlans(db, config, type.id, field);
  return {
    groupsAffected: plans.length,
    groups: Object.freeze(
      plans.map((plan) =>
        Object.freeze({
          translationGroup: plan.translationGroup,
          winnerLocale: plan.winnerLocale,
          differingLocales: plan.differingLocales,
        }),
      ),
    ),
  };
}

export type SetFieldTranslatableInput = {
  readonly contentTypeKey: string;
  readonly fieldKey: string;
  readonly translatable: boolean;
};

/**
 * Sets a field's `translatable` flag (D-23). Locks the content type row for
 * the duration of the mutation (`SELECT ... FOR UPDATE`, serializing against
 * any other schema edit on the same type). Turning it on only flips the
 * flag. Turning it off recomputes `computeGroupPlans` inside this same
 * transaction (so the plan applied always matches what a caller previewed)
 * and, for each group with a winner, locks that group in locale order
 * (`lockTranslationGroupForUpdate`, reusing one row id from the plan) and
 * applies the winner value to every differing row through
 * `applySyncedFieldChanges` -- the same draft-or-live application `save.ts`
 * uses to sync a shared field across a group. Runs through
 * `deps.recorder.run` (`content-types:edit` / `field.set-translatable`);
 * `after` carries `{ translatable, groupsAffected }`.
 */
export async function setFieldTranslatable(
  deps: ContentDeps,
  actor: AuditActor,
  input: SetFieldTranslatableInput,
): Promise<FieldDefinition> {
  const now = deps.now ?? (() => new Date());

  return await deps.recorder.run(
    actor,
    {
      permission: 'content-types:edit',
      action: 'field.set-translatable',
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

      const fields = await listFields(tx, typeRow.id);
      const field = fields.find(
        (candidate) => candidate.key === input.fieldKey,
      );
      if (field === undefined) {
        throw new Error(
          `@plakboek/content: no field "${input.fieldKey}" on content type "${input.contentTypeKey}"`,
        );
      }

      const updatedAt = now();
      let groupsAffected = 0;

      if (!input.translatable) {
        const plans = await computeGroupPlans(
          tx,
          deps.config,
          typeRow.id,
          field,
        );
        groupsAffected = plans.length;

        const type = {
          drafts: typeRow.drafts,
          revisions: typeRow.revisions,
          revisionMode: typeRow.revisionMode,
        };
        const revisionCap = await getRevisionCap(tx);

        for (const plan of plans) {
          if (plan.winnerLocale === null) continue;

          const { rows: lockedRows } = await lockTranslationGroupForUpdate(
            tx,
            plan.anyEntryId,
          );

          for (const locale of plan.differingLocales) {
            const lockedRow = lockedRows.find((row) => row.locale === locale);
            if (lockedRow === undefined) continue;

            const wrote = await applySyncedFieldChanges(tx, {
              row: lockedRow,
              type,
              fields,
              changes: { [field.key]: plan.winnerValue },
              authorId: actor.userId,
              now: updatedAt,
            });
            if (wrote) {
              await pruneSaveRevisions(tx, {
                cap: revisionCap,
                entryId: lockedRow.id,
              });
            }
          }
        }
      }

      const [row] = await tx
        .update(contentTypeFields)
        .set({ translatable: input.translatable, updatedAt })
        .where(eq(contentTypeFields.id, field.id))
        .returning();
      if (row === undefined) {
        throw new Error(
          '@plakboek/content: field translatable update returned no row',
        );
      }

      const record: FieldDefinition = {
        id: row.id,
        contentTypeId: row.contentTypeId,
        key: row.key,
        label: row.label,
        fieldType: field.fieldType,
        translatable: row.translatable,
        required: row.required,
        options: row.options,
        widget: row.widget,
        widgetOptions: row.widgetOptions,
        defaultValue: row.defaultValue,
        sortOrder: row.sortOrder,
      };
      return {
        result: record,
        after: { translatable: input.translatable, groupsAffected },
      };
    },
  );
}
