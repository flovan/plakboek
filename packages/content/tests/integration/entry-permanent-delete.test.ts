import { randomUUID } from 'node:crypto';
import {
  createAuditRecorder,
  createUserWithRole,
  PermissionDeniedError,
  type AuditActor,
  type AuditRecorder,
} from '@plakboek/auth';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import {
  createPermissionResolver,
  defaultRoles,
  defineRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineContentConfig, type ContentDeps } from '../../src/config.js';
import { createContentType } from '../../src/content-types.js';
import {
  createEntry,
  EntryNotFoundError,
  findEntry,
  listEntries,
} from '../../src/entries.js';
import { addField } from '../../src/fields.js';
import { acquireEditLock, EntryLockedError } from '../../src/locks.js';
import {
  computeEntryPermanentDeleteImpact,
  computeEntryTrashImpact,
  deleteEntryPermanently,
  trashEntry,
} from '../../src/lifecycle.js';
import { saveEntry, StaleVersionError } from '../../src/save.js';
import { createTranslation } from '../../src/translations.js';
import { FieldValidationError } from '../../src/validation.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const roles = defineRoles(defaultRoles);

describe('D-40: trash warning and permanent delete with reference stripping', () => {
  let testDatabase: TestDatabase;
  let handle: Db;
  let deps: ContentDeps;
  let resolver: PermissionResolver;
  let recorder: AuditRecorder;
  let superadmin: AuditActor;
  let editor: AuditActor;
  let otherEditor: AuditActor;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });

    resolver = createPermissionResolver(roles);
    recorder = createAuditRecorder({ db: handle.db, resolver });

    const config = defineContentConfig({
      locales: ['en', 'nl'],
      defaultLocale: 'en',
      timezone: 'Europe/Brussels',
    });

    deps = { db: handle.db, recorder, resolver, config };

    async function makeUser(
      email: string,
      roleKey: string,
    ): Promise<AuditActor> {
      const created = await createUserWithRole(handle.db, {
        id: randomUUID(),
        email,
        name: email,
        roleKey,
      });
      return { userId: created.userId, roleKey: created.roleKey };
    }

    superadmin = await makeUser('permdel-owner@example.com', 'superadmin');
    editor = await makeUser('permdel-editor@example.com', 'editor');
    otherEditor = await makeUser('permdel-other-editor@example.com', 'editor');
  });

  afterAll(async () => {
    if (handle !== undefined) await handle.close();
    if (testDatabase !== undefined) await testDatabase.drop();
  });

  let typeCounter = 0;
  function uniqueKey(prefix: string): string {
    typeCounter += 1;
    return `${prefix}${typeCounter}`;
  }

  async function indexRows(sourceEntryId: string) {
    return await handle.sql<
      { fieldId: string; targetTranslationGroup: string }[]
    >`
      SELECT field_id AS "fieldId",
        target_translation_group AS "targetTranslationGroup"
      FROM content_entry_references
      WHERE source_entry_id = ${sourceEntryId}
    `;
  }

  async function makeTargetType(prefix: string) {
    const key = uniqueKey(prefix);
    return await createContentType(deps, superadmin, {
      key,
      labelSingular: key,
      labelPlural: key,
    });
  }

  async function makeReferencingType(
    prefix: string,
    allowedTypeKeys: readonly string[],
    cardinality: 'single' | 'multiple',
    required = false,
  ) {
    const key = uniqueKey(prefix);
    const type = await createContentType(deps, superadmin, {
      key,
      labelSingular: key,
      labelPlural: key,
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'related',
      label: 'Related',
      fieldType: 'reference',
      required,
      options: { allowedTypeKeys, cardinality },
    });
    return type;
  }

  it('reports referencedBy: 2 for a target referenced by two entries; trashing proceeds and audits the count', async () => {
    const targetType = await makeTargetType('permdelTrashTarget');
    const target = await createEntry(deps, editor, {
      contentTypeKey: targetType.key,
      locale: 'en',
      data: {},
    });

    const sourceType = await makeReferencingType(
      'permdelTrashSource',
      [targetType.key],
      'single',
    );
    const sourceA = await createEntry(deps, editor, {
      contentTypeKey: sourceType.key,
      locale: 'en',
      data: {},
    });
    const sourceB = await createEntry(deps, editor, {
      contentTypeKey: sourceType.key,
      locale: 'en',
      data: {},
    });
    await saveEntry(deps, editor, {
      entryId: sourceA.id,
      baseVersion: sourceA.version,
      data: { related: target.translationGroup },
    });
    await saveEntry(deps, editor, {
      entryId: sourceB.id,
      baseVersion: sourceB.version,
      data: { related: target.translationGroup },
    });

    const impact = await computeEntryTrashImpact(deps.db, {
      entryId: target.id,
    });
    expect(impact.referencedBy).toBe(2);
    expect(
      impact.referencingEntries.map((entry) => entry.entryId).sort(),
    ).toEqual([sourceA.id, sourceB.id].sort());
    expect(
      impact.referencingEntries.every((entry) => entry.fieldKey === 'related'),
    ).toBe(true);

    const trashed = await trashEntry(deps, editor, {
      entryId: target.id,
      baseVersion: target.version,
    });
    expect(trashed.status).toBe('trashed');

    const auditRow = await handle.sql<{ after: { referencedBy: number } }[]>`
      SELECT after FROM audit_log
      WHERE action = 'entry.trash' AND entity_id = ${target.id}
      ORDER BY id DESC LIMIT 1
    `;
    expect(auditRow[0]?.after.referencedBy).toBe(2);

    const rowsA = await indexRows(sourceA.id);
    const rowsB = await indexRows(sourceB.id);
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    const currentSourceA = await findEntry(deps.db, deps.config, {
      entryId: sourceA.id,
    });
    expect(currentSourceA?.data.related).toBe(target.translationGroup);
  });

  it('deletes the only locale row of a referenced group and strips its id from every reference in one transaction', async () => {
    const targetType = await makeTargetType('permdelStripTarget');
    const target = await createEntry(deps, editor, {
      contentTypeKey: targetType.key,
      locale: 'en',
      data: {},
    });

    const otherTargetType = await makeTargetType('permdelStripOther');
    const otherTarget = await createEntry(deps, editor, {
      contentTypeKey: otherTargetType.key,
      locale: 'en',
      data: {},
    });

    const singleSourceType = await makeReferencingType(
      'permdelStripSingle',
      [targetType.key],
      'single',
    );
    const singleSource = await createEntry(deps, editor, {
      contentTypeKey: singleSourceType.key,
      locale: 'en',
      data: {},
    });
    const savedSingle = await saveEntry(deps, editor, {
      entryId: singleSource.id,
      baseVersion: singleSource.version,
      data: { related: target.translationGroup },
    });

    const multiSourceType = await makeReferencingType(
      'permdelStripMulti',
      [targetType.key, otherTargetType.key],
      'multiple',
    );
    const multiSource = await createEntry(deps, editor, {
      contentTypeKey: multiSourceType.key,
      locale: 'en',
      data: {},
    });
    const savedMulti = await saveEntry(deps, editor, {
      entryId: multiSource.id,
      baseVersion: multiSource.version,
      data: {
        related: [otherTarget.translationGroup, target.translationGroup],
      },
    });

    await deleteEntryPermanently(deps, superadmin, {
      entryId: target.id,
      baseVersion: target.version,
    });

    const reloadedSingle = await findEntry(deps.db, deps.config, {
      entryId: savedSingle.id,
    });
    expect(reloadedSingle?.data.related).toBeUndefined();
    expect(reloadedSingle?.version).toBe(savedSingle.version + 1);

    const reloadedMulti = await findEntry(deps.db, deps.config, {
      entryId: savedMulti.id,
    });
    expect(reloadedMulti?.data.related).toEqual([otherTarget.translationGroup]);
    expect(reloadedMulti?.version).toBe(savedMulti.version + 1);

    expect(await indexRows(singleSource.id)).toHaveLength(0);
    const multiRows = await indexRows(multiSource.id);
    expect(multiRows).toHaveLength(1);
    expect(multiRows[0]?.targetTranslationGroup).toBe(
      otherTarget.translationGroup,
    );
  });

  it('names an entry in entriesBlockedUntilRefilled when the stripped reference was required; that entry cannot save without refilling, while an optional reference stays saveable', async () => {
    const targetType = await makeTargetType('permdelRequiredTarget');
    const target = await createEntry(deps, editor, {
      contentTypeKey: targetType.key,
      locale: 'en',
      data: {},
    });

    const requiredSourceType = await makeReferencingType(
      'permdelRequiredSource',
      [targetType.key],
      'single',
      true,
    );
    // createEntry only checks shape (D-12), not existence, and never
    // indexes -- the required field's value must already be present at
    // creation (the target exists by now), and the reference only enters
    // `content_entry_references` on the `saveEntry` right after.
    const requiredSource = await createEntry(deps, editor, {
      contentTypeKey: requiredSourceType.key,
      locale: 'en',
      data: { related: target.translationGroup },
    });
    const savedRequired = await saveEntry(deps, editor, {
      entryId: requiredSource.id,
      baseVersion: requiredSource.version,
      data: { related: target.translationGroup },
    });

    const optionalSourceType = await makeReferencingType(
      'permdelOptionalSource',
      [targetType.key],
      'single',
      false,
    );
    const optionalSource = await createEntry(deps, editor, {
      contentTypeKey: optionalSourceType.key,
      locale: 'en',
      data: {},
    });
    const savedOptional = await saveEntry(deps, editor, {
      entryId: optionalSource.id,
      baseVersion: optionalSource.version,
      data: { related: target.translationGroup },
    });

    const impact = await computeEntryPermanentDeleteImpact(deps.db, {
      entryId: target.id,
    });
    expect(impact.isLastRowOfGroup).toBe(true);
    expect(impact.entriesBlockedUntilRefilled).toEqual([savedRequired.id]);

    await deleteEntryPermanently(deps, superadmin, {
      entryId: target.id,
      baseVersion: target.version,
    });

    const blockedError: unknown = await saveEntry(deps, editor, {
      entryId: savedRequired.id,
      baseVersion: savedRequired.version + 1,
      data: {},
    }).catch((caught: unknown) => caught);
    expect(blockedError).toBeInstanceOf(FieldValidationError);
    expect(
      (blockedError as FieldValidationError).issues.some(
        (issue) => issue.code === 'REQUIRED' && issue.fieldKey === 'related',
      ),
    ).toBe(true);

    const stillSaveable = await saveEntry(deps, editor, {
      entryId: savedOptional.id,
      baseVersion: savedOptional.version + 1,
      data: {},
    });
    expect(stillSaveable.data.related).toBeUndefined();
  });

  it('deleting one locale row of a two-locale group strips nothing; deleting the second row then strips it', async () => {
    const targetType = await makeTargetType('permdelTwoLocaleTarget');
    const targetEn = await createEntry(deps, editor, {
      contentTypeKey: targetType.key,
      locale: 'en',
      data: {},
    });
    const targetNl = await createTranslation(deps, editor, {
      sourceEntryId: targetEn.id,
      locale: 'nl',
    });
    expect(targetNl.translationGroup).toBe(targetEn.translationGroup);

    const sourceType = await makeReferencingType(
      'permdelTwoLocaleSource',
      [targetType.key],
      'single',
    );
    const source = await createEntry(deps, editor, {
      contentTypeKey: sourceType.key,
      locale: 'en',
      data: {},
    });
    const savedSource = await saveEntry(deps, editor, {
      entryId: source.id,
      baseVersion: source.version,
      data: { related: targetEn.translationGroup },
    });

    await deleteEntryPermanently(deps, superadmin, {
      entryId: targetEn.id,
      baseVersion: targetEn.version,
    });

    const stillReferenced = await findEntry(deps.db, deps.config, {
      entryId: savedSource.id,
    });
    expect(stillReferenced?.data.related).toBe(targetEn.translationGroup);
    expect(stillReferenced?.version).toBe(savedSource.version);
    expect(await indexRows(source.id)).toHaveLength(1);

    await deleteEntryPermanently(deps, superadmin, {
      entryId: targetNl.id,
      baseVersion: targetNl.version,
    });

    const stripped = await findEntry(deps.db, deps.config, {
      entryId: savedSource.id,
    });
    expect(stripped?.data.related).toBeUndefined();
    expect(await indexRows(source.id)).toHaveLength(0);
  });

  it('removes revision rows and the entry from findEntry/listEntries', async () => {
    const type = await createContentType(deps, superadmin, {
      key: uniqueKey('permdelGoneType'),
      labelSingular: 'permdelGoneType',
      labelPlural: 'permdelGoneType',
      revisions: true,
      revisionMode: 'on_every_save',
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    const savedEntry = await saveEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: entry.version,
      data: {},
    });

    const revisionCountBefore = await handle.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM entry_revisions WHERE entry_id = ${entry.id}
    `;
    expect(revisionCountBefore[0]?.count).toBeGreaterThan(0);

    await deleteEntryPermanently(deps, superadmin, {
      entryId: entry.id,
      baseVersion: savedEntry.version,
    });

    const revisionCountAfter = await handle.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM entry_revisions WHERE entry_id = ${entry.id}
    `;
    expect(revisionCountAfter[0]?.count).toBe(0);

    expect(
      await findEntry(deps.db, deps.config, { entryId: entry.id }),
    ).toBeNull();
    const listed = await listEntries(deps.db, deps.config, {
      contentTypeKey: type.key,
      locale: 'en',
      includeTrashed: true,
    });
    expect(listed.some((row) => row.id === entry.id)).toBe(false);
  });

  it('refuses without entries:delete-permanent, refuses a stale version, and refuses another users live lock', async () => {
    const type = await createContentType(deps, superadmin, {
      key: uniqueKey('permdelGuardType'),
      labelSingular: 'permdelGuardType',
      labelPlural: 'permdelGuardType',
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });

    const deniedError: unknown = await deleteEntryPermanently(deps, editor, {
      entryId: entry.id,
      baseVersion: entry.version,
    }).catch((caught: unknown) => caught);
    expect(deniedError).toBeInstanceOf(PermissionDeniedError);
    const denied = await handle.sql<{ outcome: string }[]>`
      SELECT outcome FROM audit_log
      WHERE action = 'entry.delete-permanent' AND outcome = 'denied'
      ORDER BY id DESC LIMIT 1
    `;
    expect(denied).toHaveLength(1);

    const staleError: unknown = await deleteEntryPermanently(deps, superadmin, {
      entryId: entry.id,
      baseVersion: entry.version + 999,
    }).catch((caught: unknown) => caught);
    expect(staleError).toBeInstanceOf(StaleVersionError);

    const lockedType = await createContentType(deps, superadmin, {
      key: uniqueKey('permdelLockedType'),
      labelSingular: 'permdelLockedType',
      labelPlural: 'permdelLockedType',
      editLocking: true,
    });
    const lockedEntry = await createEntry(deps, editor, {
      contentTypeKey: lockedType.key,
      locale: 'en',
      data: {},
    });
    await acquireEditLock(deps, otherEditor, { entryId: lockedEntry.id });

    const lockedError: unknown = await deleteEntryPermanently(
      deps,
      superadmin,
      {
        entryId: lockedEntry.id,
        baseVersion: lockedEntry.version,
      },
    ).catch((caught: unknown) => caught);
    expect(lockedError).toBeInstanceOf(EntryLockedError);
  });

  it('permanently deleting an entry nothing references changes no other entry and bumps no other version', async () => {
    const unrelatedType = await createContentType(deps, superadmin, {
      key: uniqueKey('permdelUnrelatedType'),
      labelSingular: 'permdelUnrelatedType',
      labelPlural: 'permdelUnrelatedType',
    });
    const unrelatedEntry = await createEntry(deps, editor, {
      contentTypeKey: unrelatedType.key,
      locale: 'en',
      data: {},
    });

    const isolatedType = await createContentType(deps, superadmin, {
      key: uniqueKey('permdelIsolatedType'),
      labelSingular: 'permdelIsolatedType',
      labelPlural: 'permdelIsolatedType',
    });
    const isolatedEntry = await createEntry(deps, editor, {
      contentTypeKey: isolatedType.key,
      locale: 'en',
      data: {},
    });

    await deleteEntryPermanently(deps, superadmin, {
      entryId: isolatedEntry.id,
      baseVersion: isolatedEntry.version,
    });

    const unchanged = await findEntry(deps.db, deps.config, {
      entryId: unrelatedEntry.id,
    });
    expect(unchanged?.version).toBe(unrelatedEntry.version);
  });

  it('two permanent deletes of the same entry started together yield one success and one EntryNotFoundError', async () => {
    const type = await createContentType(deps, superadmin, {
      key: uniqueKey('permdelRaceType'),
      labelSingular: 'permdelRaceType',
      labelPlural: 'permdelRaceType',
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });

    const results = await Promise.allSettled([
      deleteEntryPermanently(deps, superadmin, {
        entryId: entry.id,
        baseVersion: entry.version,
      }),
      deleteEntryPermanently(deps, superadmin, {
        entryId: entry.id,
        baseVersion: entry.version,
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejectedResult = rejected[0];
    const rejectedWithNotFound =
      rejectedResult?.status === 'rejected' &&
      rejectedResult.reason instanceof EntryNotFoundError;
    expect(rejectedWithNotFound).toBe(true);
  });
});
