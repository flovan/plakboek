import { randomUUID } from 'node:crypto';
import {
  createAuditRecorder,
  createUserWithRole,
  PermissionDeniedError,
  type AuditActor,
  type AuditDatabase,
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
import { createEntry, findEntry } from '../../src/entries.js';
import { addField } from '../../src/fields.js';
import {
  computeLocalePurgeEntriesImpact,
  purgeLocaleEntries,
  purgeLocaleEntriesInTransaction,
} from '../../src/locale-purge.js';
import { saveEntry } from '../../src/save.js';
import { createTranslation } from '../../src/translations.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const roles = defineRoles(defaultRoles);

/**
 * Wraps a real db handle so its very next `.transaction(...)` call runs
 * `inject()` first, then delegates to the real transaction. Every other
 * method is delegated unchanged, bound to the real handle. Used to prove a
 * write landing between a pre-transaction read and this call's own
 * transaction opening is reflected in what the transaction sees -- a
 * deterministic stand-in for a genuine concurrent write, on one connection.
 */
function withInjectedTransactionEffect(
  realDb: AuditDatabase,
  inject: () => Promise<void>,
): AuditDatabase {
  let injected = false;
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return async (
          callback: Parameters<AuditDatabase['transaction']>[0],
        ) => {
          if (!injected) {
            injected = true;
            await inject();
          }
          return await target.transaction(callback);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('Locale-scoped entry purge: impact reports, deletion, reference stripping (D-37)', () => {
  let testDatabase: TestDatabase;
  let handle: Db;
  let deps: ContentDeps;
  let resolver: PermissionResolver;
  let recorder: AuditRecorder;
  let editor: AuditActor;
  let superadmin: AuditActor;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });

    resolver = createPermissionResolver(roles);
    recorder = createAuditRecorder({ db: handle.db, resolver });

    const config = defineContentConfig({
      locales: ['en', 'nl', 'de', 'fr', 'es', 'it', 'pt'],
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

    superadmin = await makeUser('purge-owner@example.com', 'superadmin');
    editor = await makeUser('purge-editor@example.com', 'editor');
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

  it('computeLocalePurgeEntriesImpact reports concrete counts across entries, revisions, URL history and references, counting only the purged locale side of a translation group, and writes nothing; purgeLocaleEntries then deletes exactly what was reported, in one transaction, leaving the other locale untouched (D-37)', async () => {
    const revisionedType = await createContentType(deps, superadmin, {
      key: uniqueKey('purgeMainRevisioned'),
      labelSingular: 'purgeMainRevisioned',
      labelPlural: 'purgeMainRevisioned',
      revisions: true,
      revisionMode: 'on_every_save',
    });
    const targetType = await createContentType(deps, superadmin, {
      key: uniqueKey('purgeMainTarget'),
      labelSingular: 'purgeMainTarget',
      labelPlural: 'purgeMainTarget',
    });
    const referencingType = await createContentType(deps, superadmin, {
      key: uniqueKey('purgeMainReferencing'),
      labelSingular: 'purgeMainReferencing',
      labelPlural: 'purgeMainReferencing',
    });
    await addField(deps, superadmin, {
      contentTypeKey: referencingType.key,
      key: 'related',
      label: 'Related',
      fieldType: 'reference',
      options: { allowedTypeKeys: [targetType.key], cardinality: 'single' },
    });

    const groupEn = await createEntry(deps, editor, {
      contentTypeKey: revisionedType.key,
      locale: 'en',
      data: {},
    });
    const groupNl = await createTranslation(deps, editor, {
      sourceEntryId: groupEn.id,
      locale: 'nl',
    });
    await saveEntry(deps, editor, {
      entryId: groupNl.id,
      baseVersion: groupNl.version,
      data: {},
    });

    const referenceTarget = await createEntry(deps, editor, {
      contentTypeKey: targetType.key,
      locale: 'en',
      data: {},
    });
    const referencingNl = await createEntry(deps, editor, {
      contentTypeKey: referencingType.key,
      locale: 'nl',
      data: {},
    });
    const savedReferencingNl = await saveEntry(deps, editor, {
      entryId: referencingNl.id,
      baseVersion: referencingNl.version,
      data: { related: referenceTarget.translationGroup },
    });

    await handle.sql`
      INSERT INTO content_entry_url_history
        (entry_id, content_type_id, translation_group, locale, old_path, reason, changed_at)
      VALUES
        (${groupNl.id}, ${revisionedType.id}, ${groupNl.translationGroup}, 'nl', '/old/path', 'unpublished', now())
    `;

    const [entryCountBefore] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM content_entries
    `;

    const impact = await computeLocalePurgeEntriesImpact(deps.db, {
      locale: 'nl',
    });
    expect(impact).toEqual({
      locale: 'nl',
      entryCount: 2,
      revisionCount: 1,
      urlHistoryCount: 1,
      referenceCount: 1,
      translationGroupsAffected: 2,
    });

    const [entryCountAfterCompute] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM content_entries
    `;
    expect(entryCountAfterCompute?.count).toBe(entryCountBefore?.count);

    const result = await purgeLocaleEntries(deps, superadmin, {
      locale: 'nl',
    });
    expect(result).toEqual(impact);

    const [nlRemaining] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM content_entries WHERE locale = 'nl'
    `;
    expect(nlRemaining?.count).toBe('0');

    const [revisionsRemaining] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM entry_revisions WHERE entry_id = ${groupNl.id}
    `;
    expect(revisionsRemaining?.count).toBe('0');

    const [urlHistoryRemaining] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM content_entry_url_history WHERE locale = 'nl'
    `;
    expect(urlHistoryRemaining?.count).toBe('0');

    const [referencesRemaining] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM content_entry_references WHERE source_entry_id = ${referencingNl.id}
    `;
    expect(referencesRemaining?.count).toBe('0');

    // The `en` sibling of the purged group, and the untouched reference
    // target, survive with no version bump -- purging `nl` never touches
    // another locale's rows, including siblings in the same group.
    const survivingEn = await findEntry(deps.db, deps.config, {
      entryId: groupEn.id,
    });
    expect(survivingEn?.version).toBe(groupEn.version);
    const survivingTarget = await findEntry(deps.db, deps.config, {
      entryId: referenceTarget.id,
    });
    expect(survivingTarget?.version).toBe(referenceTarget.version);
    void savedReferencingNl;
  });

  it('strips a dangling reference from a surviving-locale entry when the purge empties the referenced translation group entirely, reusing the permanent-delete reference-stripper (D-38, D-39, D-40)', async () => {
    const targetType = await createContentType(deps, superadmin, {
      key: uniqueKey('purgeDanglingTarget'),
      labelSingular: 'purgeDanglingTarget',
      labelPlural: 'purgeDanglingTarget',
    });
    const referencingType = await createContentType(deps, superadmin, {
      key: uniqueKey('purgeDanglingReferencing'),
      labelSingular: 'purgeDanglingReferencing',
      labelPlural: 'purgeDanglingReferencing',
    });
    await addField(deps, superadmin, {
      contentTypeKey: referencingType.key,
      key: 'related',
      label: 'Related',
      fieldType: 'reference',
      options: { allowedTypeKeys: [targetType.key], cardinality: 'single' },
    });

    // A single-locale group: this `de` row is the only row its translation
    // group ever holds, so purging `de` empties the group entirely.
    const targetDe = await createEntry(deps, editor, {
      contentTypeKey: targetType.key,
      locale: 'de',
      data: {},
    });

    const referencingEn = await createEntry(deps, editor, {
      contentTypeKey: referencingType.key,
      locale: 'en',
      data: {},
    });
    const savedReferencingEn = await saveEntry(deps, editor, {
      entryId: referencingEn.id,
      baseVersion: referencingEn.version,
      data: { related: targetDe.translationGroup },
    });

    const impact = await computeLocalePurgeEntriesImpact(deps.db, {
      locale: 'de',
    });
    expect(impact.entryCount).toBe(1);
    // Incoming only: `referencingEn` is not itself in the purged locale, so
    // this counts the row pointing *at* the emptied group, not one *from* it.
    expect(impact.referenceCount).toBe(1);

    await purgeLocaleEntries(deps, superadmin, { locale: 'de' });

    const [targetGone] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM content_entries WHERE id = ${targetDe.id}
    `;
    expect(targetGone?.count).toBe('0');

    const reloadedReferencingEn = await findEntry(deps.db, deps.config, {
      entryId: referencingEn.id,
    });
    expect(reloadedReferencingEn?.data['related']).toBeUndefined();
    expect(reloadedReferencingEn?.version).toBe(savedReferencingEn.version + 1);
  });

  it('purging a locale with no rows succeeds, reports zeroes, and still records one allowed audit row', async () => {
    const impactBefore = await computeLocalePurgeEntriesImpact(deps.db, {
      locale: 'es',
    });
    expect(impactBefore).toEqual({
      locale: 'es',
      entryCount: 0,
      revisionCount: 0,
      urlHistoryCount: 0,
      referenceCount: 0,
      translationGroupsAffected: 0,
    });

    const result = await purgeLocaleEntries(deps, superadmin, {
      locale: 'es',
    });
    expect(result).toEqual(impactBefore);

    const auditRows = await handle.sql<{ outcome: string }[]>`
      SELECT outcome FROM audit_log
      WHERE action = 'locale.purge-entries' AND entity_id = 'es'
    `;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.outcome).toBe('allowed');
  });

  it('purgeLocaleEntries recomputes the impact inside its own transaction and returns the counts it actually deleted, not a value read before the transaction opened (T-04-13)', async () => {
    const type = await createContentType(deps, superadmin, {
      key: uniqueKey('purgeRaceType'),
      labelSingular: 'purgeRaceType',
      labelPlural: 'purgeRaceType',
    });
    await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'fr',
      data: {},
    });

    const staleImpact = await computeLocalePurgeEntriesImpact(deps.db, {
      locale: 'fr',
    });
    expect(staleImpact.entryCount).toBe(1);

    let injected = false;
    const racyDb = withInjectedTransactionEffect(handle.db, async () => {
      if (injected) return;
      injected = true;
      await createEntry(deps, editor, {
        contentTypeKey: type.key,
        locale: 'fr',
        data: {},
      });
    });
    const racyRecorder = createAuditRecorder({ db: racyDb, resolver });
    const racyDeps: ContentDeps = {
      ...deps,
      db: racyDb,
      recorder: racyRecorder,
    };

    const result = await purgeLocaleEntries(racyDeps, superadmin, {
      locale: 'fr',
    });

    // A second `fr` entry landed after `staleImpact` was read but before
    // this call's own transaction opened. The returned report matches the
    // database as of the transaction, not the earlier snapshot.
    expect(result.entryCount).toBe(2);
    expect(result.entryCount).not.toBe(staleImpact.entryCount);

    const [remaining] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM content_entries WHERE locale = 'fr'
    `;
    expect(remaining?.count).toBe('0');
  });

  it('purgeLocaleEntriesInTransaction runs with no recorder.run of its own, so a caller can run it inside its own transaction', async () => {
    const type = await createContentType(deps, superadmin, {
      key: uniqueKey('purgeTxType'),
      labelSingular: 'purgeTxType',
      labelPlural: 'purgeTxType',
    });
    await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'it',
      data: {},
    });

    const [auditCountBefore] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM audit_log WHERE action = 'locale.purge-entries'
    `;

    const result = await handle.db.transaction((tx) =>
      purgeLocaleEntriesInTransaction(tx, { locale: 'it' }),
    );
    expect(result.entryCount).toBe(1);

    const [remaining] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM content_entries WHERE locale = 'it'
    `;
    expect(remaining?.count).toBe('0');

    const [auditCountAfter] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM audit_log WHERE action = 'locale.purge-entries'
    `;
    expect(auditCountAfter?.count).toBe(auditCountBefore?.count);
  });

  it('an actor without entries:delete-permanent gets PermissionDeniedError and a denied audit row, and nothing is deleted', async () => {
    const type = await createContentType(deps, superadmin, {
      key: uniqueKey('purgeDeniedType'),
      labelSingular: 'purgeDeniedType',
      labelPlural: 'purgeDeniedType',
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'pt',
      data: {},
    });

    const deniedError: unknown = await purgeLocaleEntries(deps, editor, {
      locale: 'pt',
    }).catch((caught: unknown) => caught);
    expect(deniedError).toBeInstanceOf(PermissionDeniedError);

    const deniedRows = await handle.sql<{ outcome: string }[]>`
      SELECT outcome FROM audit_log
      WHERE action = 'locale.purge-entries' AND entity_id = 'pt' AND outcome = 'denied'
    `;
    expect(deniedRows).toHaveLength(1);

    const [stillThere] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM content_entries WHERE id = ${entry.id}
    `;
    expect(stillThere?.count).toBe('1');
  });
});
