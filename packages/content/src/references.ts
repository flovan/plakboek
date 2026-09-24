/**
 * Reference resolution and the reverse index (D-38, D-39, D-40). This module
 * owns the database-dependent half of reference correctness -- the shape
 * half (cardinality, distinctness, item bounds) belongs to the `reference`
 * field type (`field-types/reference.ts`) and is enforced by `zod` before
 * any of this module runs. A reference's stored value is a translation
 * group, not a locale row (D-39), so it resolves per reader locale rather
 * than pinning one language.
 *
 * `content_entry_references` mirrors the *live* side of an entry only: it
 * is rebuilt (delete-then-insert, never diffed) whenever `save.ts`'s live
 * branch or `publish.ts`'s promotion writes an entry's data. A pending
 * draft's references are checked (`assertReferencesResolvable`) but not
 * indexed -- the index answers "what is referenced right now", which is
 * what a trash warning and Phase 12's usage tracking both need.
 */
import type { AuditDatabase, AuditTransaction } from '@plakboek/auth';
import { eq, inArray, sql } from 'drizzle-orm';
import { listFields } from './fields.js';
import {
  contentEntries,
  contentEntryReferences,
  contentTypeFields,
  contentTypes,
} from './schema.js';
import type { FieldDefinition } from './types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A `reference` field's value is a translation group UUID (`single`) or an
 * ordered, distinct array of them (`multiple`, plan 03-03) -- both already
 * enforced by the field type's own value schema by the time this module
 * ever sees the value. Returns every group named, in stored order. */
function toGroupList(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

/** `allowedTypeKeys` from a reference field's own (already-validated)
 * stored `options` -- read directly rather than re-parsed through
 * `parseFieldOptions`, mirroring `content-types.ts`'s `findReferencingFields`
 * convention for reading a reference/repeater field's raw options. */
function allowedTypeKeysOf(options: unknown): readonly string[] {
  if (!isPlainObject(options)) return [];
  const keys = options.allowedTypeKeys;
  return Array.isArray(keys)
    ? keys.filter((key): key is string => typeof key === 'string')
    : [];
}

type ReferenceSubField = { readonly key: string; readonly options: unknown };

/** A repeater field's `reference`-typed sub-fields, from its own stored
 * `options.fields` -- `[]` for anything not shaped like repeater options
 * (D-34). */
function referenceSubFieldsOf(options: unknown): readonly ReferenceSubField[] {
  if (!isPlainObject(options) || !Array.isArray(options.fields)) return [];
  const subFields: ReferenceSubField[] = [];
  for (const subField of options.fields) {
    if (
      isPlainObject(subField) &&
      subField.fieldType === 'reference' &&
      typeof subField.key === 'string'
    ) {
      subFields.push({ key: subField.key, options: subField.options });
    }
  }
  return subFields;
}

export type ReferenceValue = {
  readonly fieldId: string;
  readonly fieldKey: string;
  readonly targetTranslationGroup: string;
  readonly allowedTypeKeys: readonly string[];
};

/**
 * Walks `fields` (sorted by `sortOrder`, so the result -- and therefore
 * whichever check consumes it first -- is deterministic) and collects every
 * reference value `data` holds: a direct `reference` field's value(s), and,
 * for a `repeater` field, every stored item's `reference` sub-field values
 * (D-34) -- attributed to the *repeater's own* field id, since a repeater
 * sub-field has no `content_type_fields` row of its own. Absent and empty
 * values contribute nothing. May return more than one entry naming the same
 * `(fieldId, targetTranslationGroup)` pair (e.g. two repeater items pointing
 * at the same target); callers that write the index dedupe that themselves.
 */
export function collectReferenceValues(
  fields: readonly FieldDefinition[],
  data: Readonly<Record<string, unknown>>,
): readonly ReferenceValue[] {
  const values: ReferenceValue[] = [];
  const sortedFields = [...fields].sort((a, b) => a.sortOrder - b.sortOrder);

  for (const field of sortedFields) {
    if (field.fieldType === 'reference') {
      const allowedTypeKeys = allowedTypeKeysOf(field.options);
      for (const group of toGroupList(data[field.key])) {
        values.push({
          fieldId: field.id,
          fieldKey: field.key,
          targetTranslationGroup: group,
          allowedTypeKeys,
        });
      }
      continue;
    }

    if (field.fieldType !== 'repeater') continue;
    const referenceSubFields = referenceSubFieldsOf(field.options);
    if (referenceSubFields.length === 0) continue;

    const items = data[field.key];
    if (!Array.isArray(items)) continue;

    for (const item of items) {
      if (!isPlainObject(item)) continue;
      for (const subField of referenceSubFields) {
        const allowedTypeKeys = allowedTypeKeysOf(subField.options);
        for (const group of toGroupList(item[subField.key])) {
          values.push({
            fieldId: field.id,
            fieldKey: field.key,
            targetTranslationGroup: group,
            allowedTypeKeys,
          });
        }
      }
    }
  }

  return values;
}

/** Thrown by `assertReferencesResolvable` when a reference names a
 * translation group no entry holds at all (T-03-61, transferred from plan
 * 03-03's T-03-16). A trashed target still exists (D-40) -- this is only
 * thrown when the query finds *no row whatsoever* for the group. */
export class ReferenceTargetMissingError extends Error {
  readonly fieldKey: string;
  readonly targetTranslationGroup: string;

  constructor(fieldKey: string, targetTranslationGroup: string) {
    super(
      `@plakboek/content: field "${fieldKey}" references translation group "${targetTranslationGroup}", which no entry holds`,
    );
    this.name = 'ReferenceTargetMissingError';
    this.fieldKey = fieldKey;
    this.targetTranslationGroup = targetTranslationGroup;
  }
}

/** Thrown by `assertReferencesResolvable` when a reference's target exists
 * but its content type is not one of the field's `allowedTypeKeys` (D-38,
 * T-03-61). */
export class ReferenceTypeNotAllowedError extends Error {
  readonly fieldKey: string;
  readonly targetTranslationGroup: string;
  readonly actualTypeKey: string;
  readonly allowedTypeKeys: readonly string[];

  constructor(
    fieldKey: string,
    targetTranslationGroup: string,
    actualTypeKey: string,
    allowedTypeKeys: readonly string[],
  ) {
    super(
      `@plakboek/content: field "${fieldKey}" references translation group "${targetTranslationGroup}" of type "${actualTypeKey}", which is not one of its allowed types (${allowedTypeKeys.join(', ')})`,
    );
    this.name = 'ReferenceTypeNotAllowedError';
    this.fieldKey = fieldKey;
    this.targetTranslationGroup = targetTranslationGroup;
    this.actualTypeKey = actualTypeKey;
    this.allowedTypeKeys = allowedTypeKeys;
  }
}

/**
 * Asserts that every reference `data` holds (per `collectReferenceValues`)
 * names a real target of an allowed type (T-03-61, D-38, D-39, D-40). Runs
 * one query joining `content_entries` to `content_types` over the distinct
 * target groups, counting a row in *any* status -- a trashed target still
 * satisfies the check (D-40: trashing proceeds, and a trashed target
 * resolves as unavailable to visitors later, rather than blocking the
 * referencing entry's saves). A group no row names at all throws
 * `ReferenceTargetMissingError`; a group that exists but whose type isn't
 * in the field's `allowedTypeKeys` throws `ReferenceTypeNotAllowedError`.
 * Both are thrown for the first offending value in `collectReferenceValues`'
 * own (field-sort-order) iteration order, so the error is deterministic.
 * A no-op when `data` holds no reference values at all.
 */
/**
 * Acquires every translation group this write will touch, in one
 * deterministic order (C-WR-02).
 *
 * A save locks its own group `FOR UPDATE` and then locks each referenced
 * target group `FOR SHARE` via `assertReferencesResolvable`. Two entries
 * that reference each other therefore took their two groups in opposite
 * orders and deadlocked. Sorting the whole set and taking it in that order
 * makes both sides agree, so one simply waits for the other.
 *
 * This is additive. The later `lockTranslationGroupForUpdate` and
 * `assertReferencesResolvable` calls re-request rows this already holds,
 * which is a no-op, so no existing behaviour changes.
 *
 * The unlocked read of the origin's own translation group is safe because an
 * entry never moves between groups.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function lockReferencedGroupsInOrder(
  tx: AuditTransaction,
  entryId: string,
  fields: readonly FieldDefinition[],
  data: Readonly<Record<string, unknown>>,
): Promise<void> {
  const [originRow] = await tx
    .select({ translationGroup: contentEntries.translationGroup })
    .from(contentEntries)
    .where(eq(contentEntries.id, entryId))
    .limit(1);
  if (originRow === undefined) return;
  const originGroup = originRow.translationGroup;

  // `data` has not been validated yet, so a reference value may be any shape
  // the caller sent. Only well-formed uuids can name a translation group, and
  // anything else is rejected by validation moments later, so skip it here
  // rather than let it reach Postgres as a malformed uuid.
  const targets = new Set(
    collectReferenceValues(fields, data)
      .map((ref) => ref.targetTranslationGroup)
      .filter((group) => UUID_PATTERN.test(group)),
  );
  targets.delete(originGroup);
  if (targets.size === 0) return;

  const ordered = [originGroup, ...targets].sort();
  for (const group of ordered) {
    await tx
      .select({ id: contentEntries.id })
      .from(contentEntries)
      .where(eq(contentEntries.translationGroup, group))
      .for(group === originGroup ? 'update' : 'share');
  }
}

export async function assertReferencesResolvable(
  tx: AuditTransaction,
  fields: readonly FieldDefinition[],
  data: Readonly<Record<string, unknown>>,
): Promise<void> {
  const refs = collectReferenceValues(fields, data);
  if (refs.length === 0) return;

  const targetGroups = [
    ...new Set(refs.map((ref) => ref.targetTranslationGroup)),
  ];

  // `FOR SHARE` (not a plain read) so this check serializes against a
  // concurrent `deleteEntryPermanently`, which locks the same rows `FOR
  // UPDATE` at the same (whole translation group) granularity: whichever
  // side gets there first, the other blocks until it commits, so the two
  // can never interleave into a stored reference to a group that's already
  // gone (D-40's concurrency edge case).
  const rows = await tx
    .select({
      translationGroup: contentEntries.translationGroup,
      typeKey: contentTypes.key,
    })
    .from(contentEntries)
    .innerJoin(contentTypes, eq(contentEntries.contentTypeId, contentTypes.id))
    .where(inArray(contentEntries.translationGroup, targetGroups))
    .for('share');

  const typeKeyByGroup = new Map<string, string>();
  for (const row of rows) {
    if (!typeKeyByGroup.has(row.translationGroup)) {
      typeKeyByGroup.set(row.translationGroup, row.typeKey);
    }
  }

  for (const ref of refs) {
    const typeKey = typeKeyByGroup.get(ref.targetTranslationGroup);
    if (typeKey === undefined) {
      throw new ReferenceTargetMissingError(
        ref.fieldKey,
        ref.targetTranslationGroup,
      );
    }
    if (!ref.allowedTypeKeys.includes(typeKey)) {
      throw new ReferenceTypeNotAllowedError(
        ref.fieldKey,
        ref.targetTranslationGroup,
        typeKey,
        ref.allowedTypeKeys,
      );
    }
  }
}

export type SyncEntryReferenceIndexInput = {
  readonly entryId: string;
  readonly fields: readonly FieldDefinition[];
  readonly data: Readonly<Record<string, unknown>>;
};

/**
 * Rebuilds `entryId`'s rows in `content_entry_references` to match `data`
 * (D-40): deletes every existing row naming `entryId` as its source, then
 * inserts one row per distinct `(fieldId, targetTranslationGroup)` pair
 * `collectReferenceValues` finds -- skipping the insert entirely when that
 * set is empty. Rows mirror the live side and are rebuilt rather than
 * diffed on every call: cheaper to reason about, and idempotent. Callers
 * (`save.ts`'s live branch and shared-field sync, `publish.ts`'s promotion)
 * call this only for a write that lands on an entry's *live* data -- a
 * pending draft is validated by `assertReferencesResolvable` but never
 * indexed.
 */
export async function syncEntryReferenceIndex(
  tx: AuditTransaction,
  input: SyncEntryReferenceIndexInput,
): Promise<void> {
  await tx
    .delete(contentEntryReferences)
    .where(eq(contentEntryReferences.sourceEntryId, input.entryId));

  const refs = collectReferenceValues(input.fields, input.data);
  if (refs.length === 0) return;

  const seen = new Set<string>();
  const rows: (typeof contentEntryReferences.$inferInsert)[] = [];
  for (const ref of refs) {
    const dedupeKey = JSON.stringify([ref.fieldId, ref.targetTranslationGroup]);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    rows.push({
      sourceEntryId: input.entryId,
      fieldId: ref.fieldId,
      targetTranslationGroup: ref.targetTranslationGroup,
    });
  }
  if (rows.length === 0) return;

  await tx.insert(contentEntryReferences).values(rows);
}

export type EntryReferenceUsageEntry = {
  readonly entryId: string;
  readonly contentTypeKey: string;
  readonly locale: string;
  readonly fieldKey: string;
  readonly required: boolean;
};

export type EntryReferenceUsage = {
  readonly referencedBy: number;
  readonly referencingEntries: readonly EntryReferenceUsageEntry[];
};

export type ComputeEntryReferenceUsageInput = {
  readonly translationGroup: string;
};

/**
 * Reports how many entries reference `translationGroup` right now, and
 * through which field(s) (D-40): reads `content_entry_references` joined to
 * its source entries, their content types and the field rows, so each hit
 * also carries whether that field is required. `referencedBy` counts
 * *distinct entries* (an entry referencing the same target from two
 * different fields still counts once); `referencingEntries` lists every
 * `(entry, field)` hit. Read-only, and typed to accept a transaction handle
 * too, so a mutation (`trashEntry`, `computeEntryPermanentDeleteImpact`) can
 * recompute this inside its own transaction without drifting from what a
 * caller previewed beforehand.
 */
export async function computeEntryReferenceUsage(
  db: AuditDatabase,
  input: ComputeEntryReferenceUsageInput,
): Promise<EntryReferenceUsage> {
  const rows = await db
    .select({
      entryId: contentEntries.id,
      contentTypeKey: contentTypes.key,
      locale: contentEntries.locale,
      fieldKey: contentTypeFields.key,
      required: contentTypeFields.required,
    })
    .from(contentEntryReferences)
    .innerJoin(
      contentEntries,
      eq(contentEntryReferences.sourceEntryId, contentEntries.id),
    )
    .innerJoin(contentTypes, eq(contentEntries.contentTypeId, contentTypes.id))
    .innerJoin(
      contentTypeFields,
      eq(contentEntryReferences.fieldId, contentTypeFields.id),
    )
    .where(
      eq(contentEntryReferences.targetTranslationGroup, input.translationGroup),
    );

  const referencingEntries: EntryReferenceUsageEntry[] = rows.map((row) => ({
    entryId: row.entryId,
    contentTypeKey: row.contentTypeKey,
    locale: row.locale,
    fieldKey: row.fieldKey,
    required: row.required,
  }));

  return {
    referencedBy: new Set(referencingEntries.map((entry) => entry.entryId))
      .size,
    referencingEntries,
  };
}

/** Removes `translationGroup` from a single reference value: drops the key
 * entirely for a `single` reference (returns `undefined`), or filters it
 * out of a `multiple` reference's array, preserving the order of the rest.
 * A value not shaped like a reference (or not holding `translationGroup`)
 * is returned unchanged with `changed: false`. */
function stripGroupFromValue(
  value: unknown,
  translationGroup: string,
): { readonly value: unknown; readonly changed: boolean } {
  if (typeof value === 'string') {
    return value === translationGroup
      ? { value: undefined, changed: true }
      : { value, changed: false };
  }
  if (Array.isArray(value)) {
    const filtered = value.filter((item) => item !== translationGroup);
    return { value: filtered, changed: filtered.length !== value.length };
  }
  return { value, changed: false };
}

/**
 * Removes every occurrence of `translationGroup` from `data`'s reference
 * fields (direct `reference` fields and `repeater` `reference` sub-fields,
 * D-34), preserving a `multiple` reference's remaining order and dropping a
 * `single` reference's key entirely rather than leaving it `null` (D-38).
 * Returns a new data object and whether anything actually changed. Exported
 * so `lifecycle.ts`'s `computeEntryPermanentDeleteImpact` can simulate the
 * same strip `stripTranslationGroupFromReferences` performs, to detect a
 * D-18 `REQUIRED` fallout before the delete runs.
 */
export function removeTranslationGroupFromEntryData(
  fields: readonly FieldDefinition[],
  data: Readonly<Record<string, unknown>>,
  translationGroup: string,
): { readonly data: Record<string, unknown>; readonly changed: boolean } {
  let changed = false;
  const result: Record<string, unknown> = { ...data };

  for (const field of fields) {
    if (field.fieldType === 'reference') {
      const stripped = stripGroupFromValue(result[field.key], translationGroup);
      if (stripped.changed) {
        changed = true;
        if (stripped.value === undefined) {
          Reflect.deleteProperty(result, field.key);
        } else {
          result[field.key] = stripped.value;
        }
      }
      continue;
    }

    if (field.fieldType !== 'repeater') continue;
    const referenceSubFieldKeys = referenceSubFieldsOf(field.options).map(
      (subField) => subField.key,
    );
    if (referenceSubFieldKeys.length === 0) continue;

    const items = result[field.key];
    if (!Array.isArray(items)) continue;

    let itemsChanged = false;
    const newItems = items.map((item) => {
      if (!isPlainObject(item)) return item;
      let itemChanged = false;
      const newItem: Record<string, unknown> = { ...item };
      for (const subKey of referenceSubFieldKeys) {
        const stripped = stripGroupFromValue(newItem[subKey], translationGroup);
        if (stripped.changed) {
          itemChanged = true;
          if (stripped.value === undefined) {
            Reflect.deleteProperty(newItem, subKey);
          } else {
            newItem[subKey] = stripped.value;
          }
        }
      }
      if (itemChanged) itemsChanged = true;
      return itemChanged ? newItem : item;
    });

    if (itemsChanged) {
      changed = true;
      result[field.key] = newItems;
    }
  }

  return { data: result, changed };
}

export type StripTranslationGroupFromReferencesInput = {
  readonly translationGroup: string;
  readonly changedAt: Date;
  readonly changedBy: string | null;
};

/**
 * Strips `translationGroup` from every reference that names it (D-40):
 * finds every distinct source entry `content_entry_references` names for
 * that group, locks and reloads each one (`FOR UPDATE`), rewrites its
 * `data` with `removeTranslationGroupFromEntryData`, and -- only for a row
 * that actually changed -- bumps its `version` and `updated_at`/`updated_by`
 * so a stale editor holding the old value in memory cannot write it back
 * (T-03-62). Deletes every index row for `translationGroup` last. Returns
 * the ids of every entry actually changed. Called by
 * `lifecycle.ts`'s `deleteEntryPermanently` inside the same transaction as
 * the delete itself, only when the deleted row was the last of its group.
 */
export async function stripTranslationGroupFromReferences(
  tx: AuditTransaction,
  input: StripTranslationGroupFromReferencesInput,
): Promise<readonly string[]> {
  const referencingRows = await tx
    .select({ entryId: contentEntryReferences.sourceEntryId })
    .from(contentEntryReferences)
    .where(
      eq(contentEntryReferences.targetTranslationGroup, input.translationGroup),
    );
  const entryIds = [...new Set(referencingRows.map((row) => row.entryId))];

  const changedEntryIds: string[] = [];

  for (const entryId of entryIds) {
    const [row] = await tx
      .select()
      .from(contentEntries)
      .where(eq(contentEntries.id, entryId))
      .for('update');
    if (row === undefined) continue;

    const fieldDefinitions = await listFields(tx, row.contentTypeId);

    const currentData = isPlainObject(row.data) ? row.data : {};
    const { data: strippedData, changed } = removeTranslationGroupFromEntryData(
      fieldDefinitions,
      currentData,
      input.translationGroup,
    );

    if (changed) {
      await tx
        .update(contentEntries)
        .set({
          data: strippedData,
          version: sql`${contentEntries.version} + 1`,
          updatedAt: input.changedAt,
          updatedBy: input.changedBy,
        })
        .where(eq(contentEntries.id, entryId));
      changedEntryIds.push(entryId);
    }
  }

  await tx
    .delete(contentEntryReferences)
    .where(
      eq(contentEntryReferences.targetTranslationGroup, input.translationGroup),
    );

  return changedEntryIds;
}
