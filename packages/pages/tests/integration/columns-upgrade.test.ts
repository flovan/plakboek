/**
 * Bringing flat trees into the column shape (D-03), proven against real
 * Postgres: the upgrade loses nothing and keeps the order, runs once, is safe
 * under a race, and a published snapshot in the old shape is wrapped on read
 * without being rewritten.
 */
import { randomUUID } from 'node:crypto';
import {
  createAuditRecorder,
  createUserWithRole,
  SUPERADMIN_ROLE_KEY,
  type AuditActor,
  type AuditDatabase,
  type AuditRecorder,
} from '@plakboek/auth';
import { defineContentConfig } from '@plakboek/content';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import {
  createPermissionResolver,
  defaultRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  upgradeAllSectionColumns,
  upgradeSectionColumns,
} from '../../src/columns.js';
import { definePagesConfig, type PagesDeps } from '../../src/config.js';
import { createPage, getPage } from '../../src/pages.js';
import { PAGE_EDIT_LOCK_TTL_SECONDS } from '../../src/locks.js';
import { setPageEditLocking } from '../../src/settings.js';
import { publishPage } from '../../src/publish.js';
import { defineBlocks } from '../../src/registry.js';
import { insertBlock, readBlockTree } from '../../src/tree.js';
import { resolvePublishedPage } from '../../src/visitor.js';
import type { BlockRecord, OwnerRef, PageRecord } from '../../src/types.js';
import { createTestDatabase } from './test-database.js';

const sectionDeclaration = {
  key: 'section',
  kind: 'section' as const,
  editor: { label: 'Section' },
  schemaVersion: 1,
  properties: {},
};
const textDeclaration = {
  key: 'text',
  editor: { label: 'Text' },
  schemaVersion: 1,
  properties: {},
};
const columnDeclaration = {
  key: 'column',
  kind: 'column' as const,
  editor: { label: 'Column' },
  schemaVersion: 1,
  properties: {},
};

describe('column shape upgrade (D-03)', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let db: AuditDatabase;
  let baseDeps: Omit<PagesDeps, 'config'>;
  let actor: AuditActor;
  let colleagueId: string;
  const clock = (): Date => new Date('2026-10-13T16:00:00.000Z');

  /** The world before columns existed: blocks sit directly under sections. */
  function flatDeps(): PagesDeps {
    return {
      ...baseDeps,
      config: definePagesConfig({
        content: defineContentConfig({
          locales: ['en'],
          defaultLocale: 'en',
          timezone: 'UTC',
        }),
        blocks: defineBlocks([sectionDeclaration, textDeclaration]),
        sectionNestingDepth: 2,
        blockDepthCeiling: 12,
      }),
    };
  }

  /** The world with the column kind registered. */
  function columnDeps(): PagesDeps {
    return {
      ...baseDeps,
      config: definePagesConfig({
        content: defineContentConfig({
          locales: ['en'],
          defaultLocale: 'en',
          timezone: 'UTC',
        }),
        blocks: defineBlocks([
          columnDeclaration,
          sectionDeclaration,
          textDeclaration,
        ]),
        sectionNestingDepth: 2,
        blockDepthCeiling: 12,
      }),
    };
  }

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });
    db = handle.db;
    const resolver: PermissionResolver = createPermissionResolver(defaultRoles);
    const recorder: AuditRecorder = createAuditRecorder({ db, resolver });
    const user = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'columns-upgrade@example.com',
      name: 'Upgrade',
      roleKey: SUPERADMIN_ROLE_KEY,
    });
    actor = { userId: user.userId, roleKey: user.roleKey };
    colleagueId = randomUUID();
    await createUserWithRole(db, {
      id: colleagueId,
      email: 'columns-upgrade-colleague@example.com',
      name: 'Colleague',
      roleKey: SUPERADMIN_ROLE_KEY,
    });
    baseDeps = { db, recorder, resolver, now: clock };
  });

  afterAll(async () => {
    await handle.close();
    await testDatabase.drop();
  });

  function ownerOf(page: PageRecord): OwnerRef {
    return { ownerType: 'page', ownerId: page.id, locale: page.locale };
  }

  async function currentPage(pageId: string): Promise<PageRecord> {
    const page = await getPage(db, pageId);
    if (page === null) throw new Error('page vanished mid-test');
    return page;
  }

  async function add(
    deps: PagesDeps,
    page: PageRecord,
    blockType: string,
    parentBlockId: string | null,
    props?: unknown,
  ): Promise<BlockRecord> {
    return await insertBlock(deps, actor, {
      owner: ownerOf(page),
      blockType,
      parentBlockId,
      ...(props === undefined ? {} : { props }),
      basePageVersion: (await currentPage(page.id)).version,
    });
  }

  type FlatFixture = {
    readonly page: PageRecord;
    readonly outer: BlockRecord;
    readonly inner: BlockRecord;
    readonly textIds: { a: string; b: string; c: string };
  };

  /** Section with two texts and a nested section holding one text. */
  async function buildFlatPage(title: string): Promise<FlatFixture> {
    const deps = flatDeps();
    const page = await createPage(deps, actor, { locale: 'en', title });
    const outer = await add(deps, page, 'section', null);
    const a = await add(deps, page, 'text', outer.id);
    const b = await add(deps, page, 'text', outer.id);
    const inner = await add(deps, page, 'section', outer.id);
    const c = await add(deps, page, 'text', inner.id);
    return {
      page: await currentPage(page.id),
      outer,
      inner,
      textIds: { a: a.id, b: b.id, c: c.id },
    };
  }

  async function depthsOf(pageId: string): Promise<Record<string, number>> {
    const rows = await handle.sql<{ id: string; depth: number }[]>`
      SELECT id, depth FROM page_blocks WHERE owner_id = ${pageId}
    `;
    return Object.fromEntries(rows.map((row) => [row.id, row.depth]));
  }

  async function blockCount(pageId: string): Promise<number> {
    const [row] = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM page_blocks WHERE owner_id = ${pageId}
    `;
    return Number(row?.count ?? '0');
  }

  it('moves every section child into one new column, keeping order, depths and data', async () => {
    const fixture = await buildFlatPage('Upgrade lossless');
    const { page, outer, inner, textIds } = fixture;
    const before = await blockCount(page.id);
    const deps = columnDeps();

    const result = await upgradeSectionColumns(deps, { pageId: page.id });

    expect(result).toEqual({ upgraded: true, pageVersion: page.version + 1 });
    expect((await currentPage(page.id)).version).toBe(page.version + 1);
    expect(await blockCount(page.id)).toBe(before + 2);

    const tree = await readBlockTree(db, ownerOf(page));
    const outerNode = tree[0];
    expect(outerNode?.children.map((child) => child.blockType)).toEqual([
      'column',
    ]);
    const outerColumn = outerNode?.children[0];
    expect(outerColumn?.children.map((child) => child.id)).toEqual([
      textIds.a,
      textIds.b,
      inner.id,
    ]);
    const innerColumn = outerColumn?.children[2]?.children[0];
    expect(innerColumn?.blockType).toBe('column');
    expect(innerColumn?.children.map((child) => child.id)).toEqual([textIds.c]);

    const depths = await depthsOf(page.id);
    expect(depths[outer.id]).toBe(0);
    expect(depths[outerColumn?.id ?? '']).toBe(1);
    expect(depths[textIds.a]).toBe(2);
    expect(depths[textIds.b]).toBe(2);
    expect(depths[inner.id]).toBe(2);
    expect(depths[innerColumn?.id ?? '']).toBe(3);
    expect(depths[textIds.c]).toBe(4);

    // One batch: a create per new column and a move per re-parented child,
    // with no author and the pre-move parent and depth.
    const revisions = await handle.sql<
      {
        batch: string;
        changeType: string;
        blockId: string | null;
        parent: string | null;
        depth: number;
        author: string | null;
      }[]
    >`
      SELECT revision_batch_id AS batch, change_type AS "changeType",
        block_id AS "blockId", parent_block_id AS parent, depth,
        author_id AS author
      FROM block_revisions
      WHERE owner_id = ${page.id} AND author_id IS NULL
    `;
    expect(new Set(revisions.map((row) => row.batch)).size).toBe(1);
    expect(revisions.filter((row) => row.changeType === 'create')).toHaveLength(
      2,
    );
    const moves = revisions.filter((row) => row.changeType === 'move');
    expect(moves).toHaveLength(4);
    expect(new Set(moves.map((row) => row.blockId))).toEqual(
      new Set([textIds.a, textIds.b, inner.id, textIds.c]),
    );
    const moveOfA = moves.find((row) => row.blockId === textIds.a);
    expect(moveOfA).toMatchObject({ parent: outer.id, depth: 1 });
  });

  it('waits for a property edit in flight and records the props that were committed, not the ones it read first (WR-D-04)', async () => {
    const { page, textIds } = await buildFlatPage('Upgrade reads locked rows');
    const deps = columnDeps();

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let editStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      editStarted = resolve;
    });
    // A property edit that has changed the row and not yet committed. It
    // takes no page lock, like `updateBlockProps`.
    const edit = handle.sql.begin(async (sql) => {
      await sql`
        UPDATE page_blocks
        SET props = '{"edited":true}'::jsonb, version = version + 1
        WHERE id = ${textIds.a}
      `;
      editStarted();
      await held;
    });
    await started;

    const upgrade = upgradeSectionColumns(deps, { pageId: page.id });
    // Let the upgrade reach the blocks it reads, then let the edit commit.
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await edit;
    expect((await upgrade).upgraded).toBe(true);

    const [revision] = await handle.sql<{ props: unknown }[]>`
      SELECT props FROM block_revisions
      WHERE block_id = ${textIds.a} AND change_type = 'move'
    `;
    expect(revision?.props).toEqual({ edited: true });
  });

  it('changes nothing on a second run', async () => {
    const { page } = await buildFlatPage('Upgrade idempotent');
    const deps = columnDeps();
    await upgradeSectionColumns(deps, { pageId: page.id });
    const versionAfterFirst = (await currentPage(page.id)).version;
    const blocksAfterFirst = await blockCount(page.id);

    const again = await upgradeSectionColumns(deps, { pageId: page.id });

    expect(again).toEqual({ upgraded: false, pageVersion: null });
    expect((await currentPage(page.id)).version).toBe(versionAfterFirst);
    expect(await blockCount(page.id)).toBe(blocksAfterFirst);
  });

  it('leaves exactly one column per section when two runs race on one page', async () => {
    const { page, outer, inner } = await buildFlatPage('Upgrade race');
    const deps = columnDeps();

    const results = await Promise.all([
      upgradeSectionColumns(deps, { pageId: page.id }),
      upgradeSectionColumns(deps, { pageId: page.id }),
    ]);

    expect(results.filter((result) => result.upgraded)).toHaveLength(1);
    expect((await currentPage(page.id)).version).toBe(page.version + 1);
    const rows = await handle.sql<{ parent: string; count: string }[]>`
      SELECT parent_block_id AS parent, count(*)::text AS count
      FROM page_blocks
      WHERE owner_id = ${page.id} AND block_type = 'column'
      GROUP BY parent_block_id
    `;
    expect(new Map(rows.map((row) => [row.parent, row.count]))).toEqual(
      new Map([
        [outer.id, '1'],
        [inner.id, '1'],
      ]),
    );
  });

  it('gives a section with no children one empty column', async () => {
    const deps = flatDeps();
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Upgrade empty section',
    });
    const section = await add(deps, page, 'section', null);

    const result = await upgradeSectionColumns(columnDeps(), {
      pageId: page.id,
    });

    expect(result.upgraded).toBe(true);
    const tree = await readBlockTree(db, ownerOf(page));
    expect(tree[0]?.id).toBe(section.id);
    expect(tree[0]?.children.map((child) => child.blockType)).toEqual([
      'column',
    ]);
    expect(tree[0]?.children[0]?.children).toEqual([]);
  });

  it('wraps a flat published snapshot on read and never rewrites the stored one', async () => {
    const flat = flatDeps();
    const page = await createPage(flat, actor, {
      locale: 'en',
      title: 'Upgrade published',
    });
    const section = await add(flat, page, 'section', null);
    const body = await add(flat, page, 'text', section.id);
    await publishPage(flat, actor, {
      pageId: page.id,
      baseVersion: (await currentPage(page.id)).version,
    });
    const [stored] = await handle.sql<{ snapshot: unknown }[]>`
      SELECT snapshot FROM page_publications WHERE page_id = ${page.id}
    `;

    columnDeps();
    const view = await resolvePublishedPage(db, {
      locale: 'en',
      resolvedPath: 'en/upgrade-published',
    });

    const blocks = view?.publication.snapshot.blocks;
    expect(blocks?.[0]?.children.map((child) => child.blockType)).toEqual([
      'column',
    ]);
    expect(blocks?.[0]?.children[0]?.children.map((child) => child.id)).toEqual(
      [body.id],
    );
    const [after] = await handle.sql<{ snapshot: unknown }[]>`
      SELECT snapshot FROM page_publications WHERE page_id = ${page.id}
    `;
    expect(after?.snapshot).toEqual(stored?.snapshot);
    expect(JSON.stringify(after?.snapshot)).not.toContain('column');
  });

  it('upgrades every flat page and skips one that is already shaped', async () => {
    await upgradeAllSectionColumns(columnDeps());
    const first = await buildFlatPage('Upgrade all one');
    const second = await buildFlatPage('Upgrade all two');
    const columns = columnDeps();
    const shapedPage = await createPage(columns, actor, {
      locale: 'en',
      title: 'Upgrade all shaped',
    });
    const shapedSection = await add(columns, shapedPage, 'section', null);
    await add(columns, shapedPage, 'column', shapedSection.id);
    const shapedVersion = (await currentPage(shapedPage.id)).version;

    const result = await upgradeAllSectionColumns(columnDeps());

    expect(result).toEqual({ pages: 2, upgraded: 2 });
    for (const fixture of [first, second]) {
      const tree = await readBlockTree(db, ownerOf(fixture.page));
      expect(tree[0]?.children.map((child) => child.blockType)).toEqual([
        'column',
      ]);
    }
    expect((await currentPage(shapedPage.id)).version).toBe(shapedVersion);
    expect(await upgradeAllSectionColumns(columnDeps())).toEqual({
      pages: 0,
      upgraded: 0,
    });
  });
  describe('and the page edit lock', () => {
    async function holdLock(
      pageId: string,
      userId: string,
      ageSeconds = 0,
    ): Promise<void> {
      const lockedAt = new Date(clock().getTime() - ageSeconds * 1000);
      await handle.sql`
        UPDATE pages
        SET locked_by = ${userId}, locked_at = ${lockedAt.toISOString()}
        WHERE id = ${pageId}
      `;
    }

    async function typesUnderFirstSection(page: PageRecord): Promise<string[]> {
      const tree = await readBlockTree(db, ownerOf(page));
      return (tree[0]?.children ?? []).map((child) => child.blockType);
    }

    it('leaves a page someone else is editing alone, version included', async () => {
      const { page } = await buildFlatPage('Upgrade held page');
      await holdLock(page.id, colleagueId);

      const result = await upgradeSectionColumns(columnDeps(), {
        pageId: page.id,
        actorUserId: actor.userId,
      });

      expect(result).toEqual({ upgraded: false, pageVersion: null });
      expect((await currentPage(page.id)).version).toBe(page.version);
      expect(await typesUnderFirstSection(page)).toEqual([
        'text',
        'text',
        'section',
      ]);
      // With no acting user a live lock of anyone holds the run back too.
      const background = await upgradeSectionColumns(columnDeps(), {
        pageId: page.id,
      });
      expect(background.upgraded).toBe(false);
    });

    it('upgrades a page the acting user holds, or whose lock lapsed, or while locking is off', async () => {
      const own = await buildFlatPage('Upgrade own lock');
      await holdLock(own.page.id, actor.userId);
      expect(
        (
          await upgradeSectionColumns(columnDeps(), {
            pageId: own.page.id,
            actorUserId: actor.userId,
          })
        ).upgraded,
      ).toBe(true);

      const lapsed = await buildFlatPage('Upgrade lapsed lock');
      await holdLock(lapsed.page.id, colleagueId, PAGE_EDIT_LOCK_TTL_SECONDS);
      expect(
        (
          await upgradeSectionColumns(columnDeps(), {
            pageId: lapsed.page.id,
            actorUserId: actor.userId,
          })
        ).upgraded,
      ).toBe(true);

      const unlocked = await buildFlatPage('Upgrade locking off');
      await holdLock(unlocked.page.id, colleagueId);
      await setPageEditLocking(columnDeps(), actor, { enabled: false });
      try {
        expect(
          (
            await upgradeSectionColumns(columnDeps(), {
              pageId: unlocked.page.id,
              actorUserId: actor.userId,
            })
          ).upgraded,
        ).toBe(true);
      } finally {
        await setPageEditLocking(columnDeps(), actor, { enabled: true });
      }
    });

    it('skips held pages in the batch upgrade without letting them fill the batch', async () => {
      await upgradeAllSectionColumns(columnDeps());
      const held = await buildFlatPage('Upgrade batch held');
      const alsoHeld = await buildFlatPage('Upgrade batch also held');
      const free = await buildFlatPage('Upgrade batch free');
      await holdLock(held.page.id, colleagueId);
      await holdLock(alsoHeld.page.id, colleagueId);

      const result = await upgradeAllSectionColumns(columnDeps(), {
        batchSize: 2,
      });

      expect(result).toEqual({ pages: 1, upgraded: 1 });
      expect(await typesUnderFirstSection(free.page)).toEqual(['column']);
      for (const fixture of [held, alsoHeld]) {
        expect((await currentPage(fixture.page.id)).version).toBe(
          fixture.page.version,
        );
      }

      // Once the locks are gone, the next run picks the pages up.
      await holdLock(held.page.id, colleagueId, PAGE_EDIT_LOCK_TTL_SECONDS);
      await holdLock(alsoHeld.page.id, colleagueId, PAGE_EDIT_LOCK_TTL_SECONDS);
      expect(await upgradeAllSectionColumns(columnDeps())).toEqual({
        pages: 2,
        upgraded: 2,
      });
    });
  });
});
