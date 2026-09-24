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
import { createEntry } from '../../src/entries.js';
import { addField } from '../../src/fields.js';
import { publishEntry } from '../../src/publish.js';
import { pruneSaveRevisions } from '../../src/revisions.js';
import { saveEntry } from '../../src/save.js';
import {
  computeRevisionCapImpact,
  RevisionCapError,
  setRevisionCap,
} from '../../src/settings.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const roles = defineRoles({
  ...defaultRoles,
  contributor: ['entries:read', 'entries:create', 'entries:edit'],
});

describe('Revision snapshots per mode, the project cap and pruning (TYPE-08, D-13, D-14, D-15, D-16)', () => {
  let testDatabase: TestDatabase;
  let handle: Db;
  let deps: ContentDeps;
  let resolver: PermissionResolver;
  let recorder: AuditRecorder;

  let superadmin: AuditActor;
  let editor: AuditActor;

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

    superadmin = await makeUser('revisions-owner@example.com', 'superadmin');
    editor = await makeUser('revisions-editor@example.com', 'editor');
  });

  afterAll(async () => {
    if (handle !== undefined) await handle.close();
    if (testDatabase !== undefined) await testDatabase.drop();
  });

  async function revisionCount(
    entryId: string,
    kind: 'save' | 'publish',
  ): Promise<number> {
    const [row] = await handle.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM entry_revisions
      WHERE entry_id = ${entryId} AND kind = ${kind}
    `;
    return row?.count ?? 0;
  }

  async function revisionCapAuditCount(outcome: string): Promise<number> {
    const [row] = await handle.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM audit_log
      WHERE action = 'settings.revision-cap' AND outcome = ${outcome}
    `;
    return row?.count ?? 0;
  }

  it('revisions off: publish writes no publish row and liveRevisionId stays null', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'noRevisionsType',
      labelSingular: 'No revisions type',
      labelPlural: 'No revisions types',
      drafts: false,
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    const published = await publishEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: entry.version,
    });
    expect(published.liveRevisionId).toBeNull();
    expect(await revisionCount(entry.id, 'publish')).toBe(0);
  });

  it('on-publish mode: three saves then a publish leave exactly one revision (kind publish) and liveRevisionId points to it; a drafts-off live save of a published entry writes another publish row', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'onPublishType',
      labelSingular: 'On publish type',
      labelPlural: 'On publish types',
      drafts: false,
      revisions: true,
      revisionMode: 'on_publish',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'note',
      label: 'Note',
      fieldType: 'short_text',
    });

    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    let current = entry;
    for (const value of ['one', 'two', 'three']) {
      current = await saveEntry(deps, editor, {
        entryId: current.id,
        baseVersion: current.version,
        data: { note: value },
      });
    }
    expect(await revisionCount(entry.id, 'save')).toBe(0);
    expect(await revisionCount(entry.id, 'publish')).toBe(0);

    const published = await publishEntry(deps, editor, {
      entryId: current.id,
      baseVersion: current.version,
    });
    expect(await revisionCount(entry.id, 'publish')).toBe(1);
    expect(published.liveRevisionId).not.toBeNull();

    const savedAgain = await saveEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: published.version,
      data: { note: 'four' },
    });
    expect(savedAgain.status).toBe('published');
    expect(await revisionCount(entry.id, 'publish')).toBe(2);
    expect(savedAgain.liveRevisionId).not.toBe(published.liveRevisionId);
    expect(await revisionCount(entry.id, 'save')).toBe(0);
  });

  it('on-every-save mode, never published: three saves write three save rows in order', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'everySaveNeverPublished',
      labelSingular: 'Every save never published',
      labelPlural: 'Every save never published',
      drafts: false,
      revisions: true,
      revisionMode: 'on_every_save',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'note',
      label: 'Note',
      fieldType: 'short_text',
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });

    let current = entry;
    for (const value of ['a', 'b', 'c']) {
      current = await saveEntry(deps, editor, {
        entryId: current.id,
        baseVersion: current.version,
        data: { note: value },
      });
    }
    expect(await revisionCount(entry.id, 'save')).toBe(3);
    expect(await revisionCount(entry.id, 'publish')).toBe(0);
  });

  it('on-every-save mode, drafts on, published: a save writes a save row that draftRevisionId points to; two more saves keep all three rows', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'everySaveDraftsOn',
      labelSingular: 'Every save drafts on',
      labelPlural: 'Every save drafts on',
      drafts: true,
      revisions: true,
      revisionMode: 'on_every_save',
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    const published = await publishEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: entry.version,
    });
    // The publish itself already writes one `publish` row (type.revisions is
    // true, regardless of mode) -- unaffected by the pending-save assertions
    // below, which only count `save`-kind rows.
    expect(await revisionCount(entry.id, 'publish')).toBe(1);

    const first = await saveEntry(deps, editor, {
      entryId: published.id,
      baseVersion: published.version,
      data: {},
    });
    expect(first.draftRevisionId).not.toBeNull();
    expect(await revisionCount(entry.id, 'save')).toBe(1);

    const second = await saveEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: first.version,
      data: {},
    });
    const third = await saveEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: second.version,
      data: {},
    });
    expect(third.draftRevisionId).not.toBeNull();
    expect(await revisionCount(entry.id, 'save')).toBe(3);
  });

  it('a pending draft row older than the newest two is kept while draftRevisionId points to it', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'protectedPointerType',
      labelSingular: 'Protected pointer type',
      labelPlural: 'Protected pointer types',
      drafts: true,
      revisions: true,
      revisionMode: 'on_every_save',
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });

    // Three `save`-kind rows for this entry, oldest first, inserted
    // directly: `saveEntry`'s own flow always points draft_revision_id at
    // the row it just created (always the newest), so it can never produce
    // a state where the pointer names an OLD row -- exactly the state this
    // test constructs to prove the exclusion clause is load-bearing.
    const base = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const [row] = await handle.sql<{ id: string }[]>`
        INSERT INTO entry_revisions (entry_id, locale, kind, data, field_ids, created_at)
        VALUES (${entry.id}, 'en', 'save', '{}'::jsonb, '{}'::jsonb, ${new Date(base + i * 1000).toISOString()})
        RETURNING id
      `;
      if (row === undefined) throw new Error('fixture insert failed');
      ids.push(row.id);
    }
    const [oldest, , newest] = ids as [string, string, string];
    // Points draft_revision_id at the OLDEST row -- an artificial state a
    // real save can't reach, constructed specifically to exercise the
    // pointer-exclusion clause.
    await handle.sql`UPDATE content_entries SET draft_revision_id = ${oldest} WHERE id = ${entry.id}`;

    const pruned = await handle.db.transaction(async (tx) => {
      return await pruneSaveRevisions(tx, { cap: 1, entryId: entry.id });
    });
    // Rank 1 (newest) is kept by cap alone; rank 2 (middle) is pruned; rank
    // 3 (oldest) would be pruned by rank too, but is protected because
    // draft_revision_id still points to it.
    expect(pruned).toBe(1);

    const remaining = await handle.sql<{ id: string }[]>`
      SELECT id FROM entry_revisions WHERE entry_id = ${entry.id} ORDER BY id
    `;
    expect(remaining.map((row) => row.id).sort()).toEqual(
      [oldest, newest].sort(),
    );
  });

  it('computeRevisionCapImpact(db, 1) reports the entries and rows it would prune; setRevisionCap to 1 prunes exactly that many rows in the same transaction and writes one audit row', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'capImpactType',
      labelSingular: 'Cap impact type',
      labelPlural: 'Cap impact types',
      drafts: false,
      revisions: true,
      revisionMode: 'on_every_save',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'note',
      label: 'Note',
      fieldType: 'short_text',
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    let current = entry;
    for (const value of ['a', 'b', 'c']) {
      current = await saveEntry(deps, editor, {
        entryId: current.id,
        baseVersion: current.version,
        data: { note: value },
      });
    }
    expect(await revisionCount(entry.id, 'save')).toBe(3);

    const impact = await computeRevisionCapImpact(deps.db, 1);
    expect(impact.entriesAffected).toBeGreaterThanOrEqual(1);
    expect(impact.revisionsToPrune).toBeGreaterThanOrEqual(2);

    // settings.revision-cap is project-wide and records no entity_id, and
    // sibling tests in this file set the cap too, so count the delta around
    // this call. An exact delta of one still catches a duplicate write, which
    // an `ORDER BY id DESC LIMIT 1` could not.
    const allowedBefore = await revisionCapAuditCount('allowed');
    await setRevisionCap(deps, superadmin, { cap: 1 });
    expect(await revisionCount(entry.id, 'save')).toBe(1);
    expect((await revisionCapAuditCount('allowed')) - allowedBefore).toBe(1);

    // Reset for subsequent tests, which assume an uncapped project.
    await setRevisionCap(deps, superadmin, { cap: 0 });
  });

  it('setRevisionCap with -1 throws RevisionCapError; cap 0 prunes nothing', async () => {
    const error: unknown = await setRevisionCap(deps, superadmin, {
      cap: -1,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RevisionCapError);

    const type = await createContentType(deps, superadmin, {
      key: 'capZeroType',
      labelSingular: 'Cap zero type',
      labelPlural: 'Cap zero types',
      drafts: false,
      revisions: true,
      revisionMode: 'on_every_save',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'note',
      label: 'Note',
      fieldType: 'short_text',
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    let current = entry;
    for (const value of ['1', '2', '3']) {
      current = await saveEntry(deps, editor, {
        entryId: current.id,
        baseVersion: current.version,
        data: { note: value },
      });
    }
    expect(await revisionCount(entry.id, 'save')).toBe(3);

    await setRevisionCap(deps, superadmin, { cap: 0 });
    expect(await revisionCount(entry.id, 'save')).toBe(3);
  });

  it('with cap 2, four saves in on-every-save mode leave the newest two save rows plus every publish row', async () => {
    await setRevisionCap(deps, superadmin, { cap: 2 });
    try {
      const type = await createContentType(deps, superadmin, {
        key: 'cappedType',
        labelSingular: 'Capped type',
        labelPlural: 'Capped types',
        drafts: false,
        revisions: true,
        revisionMode: 'on_every_save',
      });
      await addField(deps, superadmin, {
        contentTypeKey: type.key,
        key: 'note',
        label: 'Note',
        fieldType: 'short_text',
      });
      const entry = await createEntry(deps, editor, {
        contentTypeKey: type.key,
        locale: 'en',
        data: {},
      });

      let current = entry;
      for (const value of ['1', '2', '3', '4']) {
        current = await saveEntry(deps, editor, {
          entryId: current.id,
          baseVersion: current.version,
          data: { note: value },
        });
      }
      expect(await revisionCount(entry.id, 'save')).toBe(2);

      await publishEntry(deps, editor, {
        entryId: current.id,
        baseVersion: current.version,
      });
      expect(await revisionCount(entry.id, 'publish')).toBe(1);
      // Pruning only ever targets `save`-kind rows -- the publish row above
      // and the newest two save rows all remain.
      expect(await revisionCount(entry.id, 'save')).toBe(2);
    } finally {
      // Reset for subsequent tests, which assume an uncapped project.
      await setRevisionCap(deps, superadmin, { cap: 0 });
    }
  });

  it('a user without settings:manage gets PermissionDeniedError and a denied row', async () => {
    const deniedBefore = await revisionCapAuditCount('denied');

    const error: unknown = await setRevisionCap(deps, editor, {
      cap: 1,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PermissionDeniedError);

    expect((await revisionCapAuditCount('denied')) - deniedBefore).toBe(1);
  });
});
