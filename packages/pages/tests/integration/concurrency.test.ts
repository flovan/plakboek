/**
 * D-38's dual-scope optimistic concurrency contract, proven as races against
 * real Postgres (04-06-PLAN.md Task 2) -- not as assertions about code
 * shape. A property edit checks/bumps only the touched block's own
 * `version`; insert, move and delete additionally check/bump the owning
 * page's `version`. Reuses Phase 3's proven technique
 * (`packages/content/tests/integration/entries-save.test.ts`,
 * `locks.test.ts`): `Promise.allSettled` for the races themselves, and a
 * `pg_locks` poll scoped to the exact blocking `transactionid` for the one
 * test that proves a race is a genuine database-level block rather than a
 * post-hoc version comparison.
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
import { definePagesConfig, type PagesDeps } from '../../src/config.js';
import { createPage, getPage } from '../../src/pages.js';
import { defineBlocks } from '../../src/registry.js';
import type { BlockRecord, OwnerRef, PageRecord } from '../../src/types.js';
import {
  deleteBlock,
  insertBlock,
  moveBlock,
  StaleBlockVersionError,
  StalePageVersionError,
  updateBlockProps,
} from '../../src/tree.js';
import { createTestDatabase } from './test-database.js';

const roles = defaultRoles;

describe('D-38 dual-scope version contract, raced against real Postgres', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let db: AuditDatabase;
  let deps: PagesDeps;
  let actor: AuditActor;
  const clock = (): Date => new Date('2026-09-25T13:00:00.000Z');

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });
    db = handle.db;

    const resolver: PermissionResolver = createPermissionResolver(roles);
    const recorder: AuditRecorder = createAuditRecorder({ db, resolver });
    const config = definePagesConfig({
      content: defineContentConfig({
        locales: ['en'],
        defaultLocale: 'en',
        timezone: 'UTC',
      }),
      blocks: defineBlocks([
        {
          key: 'section',
          kind: 'section',
          editor: { label: 'Section' },
          schemaVersion: 1,
          properties: {},
        },
        {
          key: 'heading',
          editor: { label: 'Heading' },
          schemaVersion: 1,
          properties: { text: { fieldType: 'short_text', label: 'Text' } },
        },
      ]),
    });

    const superadminUser = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'owner@example.com',
      name: 'Owner',
      roleKey: SUPERADMIN_ROLE_KEY,
    });
    actor = { userId: superadminUser.userId, roleKey: superadminUser.roleKey };
    deps = { db, recorder, resolver, config, now: clock };
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

  type Fixture = {
    readonly page: PageRecord;
    readonly owner: OwnerRef;
    readonly section: BlockRecord;
    readonly siblings: readonly BlockRecord[];
  };

  /** "A page carrying one section and three sibling blocks inside it"
   * (04-06-PLAN.md Task 2's own fixture description) -- a fresh page per
   * test, so no race in one `it` can leave version state a later `it`
   * depends on. */
  async function buildFixture(title: string): Promise<Fixture> {
    const page = await createPage(deps, actor, { locale: 'en', title });
    const owner = ownerOf(page);
    const section = await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: null,
      basePageVersion: page.version,
    });
    const siblings: BlockRecord[] = [];
    for (let index = 0; index < 3; index += 1) {
      siblings.push(
        await insertBlock(deps, actor, {
          owner,
          blockType: 'heading',
          parentBlockId: section.id,
          props: { text: `Heading ${index}` },
          basePageVersion: (await currentPage(page.id)).version,
        }),
      );
    }
    return {
      page: await currentPage(page.id),
      owner,
      section,
      siblings,
    };
  }

  function fulfilledOf<T>(results: readonly PromiseSettledResult<T>[]): T[] {
    return results
      .filter(
        (result): result is PromiseFulfilledResult<T> =>
          result.status === 'fulfilled',
      )
      .map((result) => result.value);
  }

  function rejectedOf(
    results: readonly PromiseSettledResult<unknown>[],
  ): unknown[] {
    return results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )
      .map((result) => result.reason);
  }

  it('two property edits on different blocks, concurrently: both fulfil, both blocks reach version 2, the page version is unchanged', async () => {
    const { page, siblings } = await buildFixture(
      'Different blocks, no collision',
    );
    const [blockA, blockB] = siblings;
    if (blockA === undefined || blockB === undefined) {
      throw new Error('fixture did not produce two siblings');
    }

    const results = await Promise.allSettled([
      updateBlockProps(deps, actor, {
        blockId: blockA.id,
        baseVersion: blockA.version,
        props: { text: 'A updated' },
      }),
      updateBlockProps(deps, actor, {
        blockId: blockB.id,
        baseVersion: blockB.version,
        props: { text: 'B updated' },
      }),
    ]);

    expect(fulfilledOf(results)).toHaveLength(2);
    const [resultA, resultB] = fulfilledOf(results) as [
      BlockRecord,
      BlockRecord,
    ];
    expect(resultA.version).toBe(2);
    expect(resultB.version).toBe(2);
    expect((await currentPage(page.id)).version).toBe(page.version);
  });

  it('two property edits on the same block, same base version: exactly one fulfils, the other rejects with StaleBlockVersionError, and the stored props equal the winner', async () => {
    const { siblings } = await buildFixture('Same block, same base version');
    const [target] = siblings;
    if (target === undefined) throw new Error('fixture missing a sibling');

    const results = await Promise.allSettled([
      updateBlockProps(deps, actor, {
        blockId: target.id,
        baseVersion: target.version,
        props: { text: 'First writer' },
      }),
      updateBlockProps(deps, actor, {
        blockId: target.id,
        baseVersion: target.version,
        props: { text: 'Second writer' },
      }),
    ]);

    const fulfilled = fulfilledOf(results) as BlockRecord[];
    const rejected = rejectedOf(results);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(StaleBlockVersionError);

    const winner = fulfilled[0];
    if (winner === undefined) throw new Error('no fulfilled result');
    const [storedRow] = await handle.sql<{ text: string }[]>`
      SELECT props->>'text' AS text FROM page_blocks WHERE id = ${target.id}
    `;
    expect(storedRow?.text).toBe((winner.props as { text: string }).text);
  });

  it('two structural changes from the same base page version: exactly one fulfils, the other rejects with StalePageVersionError, the page version advances by exactly 1', async () => {
    const { page, owner, section, siblings } = await buildFixture(
      'Two structural changes, same base page version',
    );
    const [moving] = siblings;
    const last = siblings[siblings.length - 1];
    if (moving === undefined || last === undefined) {
      throw new Error('fixture missing a sibling');
    }
    const basePageVersion = page.version;

    // Both racers must be valid on their own: the page version is checked under
    // the page lock before any placement check, so only the second racer fails
    // on the stale version. A move to an invalid destination fails on placement
    // when it wins the lock and lets the insert through.
    const results = await Promise.allSettled([
      insertBlock(deps, actor, {
        owner,
        blockType: 'heading',
        parentBlockId: section.id,
        props: { text: 'Racer insert' },
        basePageVersion,
      }),
      moveBlock(deps, actor, {
        blockId: moving.id,
        baseVersion: moving.version,
        pageId: page.id,
        basePageVersion,
        newParentBlockId: section.id,
        beforeSiblingId: last.id,
      }),
    ]);

    const fulfilled = fulfilledOf(results);
    const rejected = rejectedOf(results);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(StalePageVersionError);
    expect((await currentPage(page.id)).version).toBe(basePageVersion + 1);
  });

  it('a property edit concurrent with a structural change: both fulfil, since a property edit never takes the page version (D-38)', async () => {
    const { page, owner, section, siblings } = await buildFixture(
      'Property edit vs structural change, no collision',
    );
    const [editing] = siblings;
    if (editing === undefined) throw new Error('fixture missing a sibling');
    const basePageVersion = page.version;

    const results = await Promise.allSettled([
      updateBlockProps(deps, actor, {
        blockId: editing.id,
        baseVersion: editing.version,
        props: { text: 'Edited concurrently' },
      }),
      insertBlock(deps, actor, {
        owner,
        blockType: 'heading',
        parentBlockId: section.id,
        props: { text: 'Inserted concurrently' },
        basePageVersion,
      }),
    ]);

    expect(fulfilledOf(results)).toHaveLength(2);
    const editedBlock = await handle.sql<{ version: number }[]>`
      SELECT version FROM page_blocks WHERE id = ${editing.id}
    `;
    expect(editedBlock[0]?.version).toBe(editing.version + 1);
    expect((await currentPage(page.id)).version).toBe(basePageVersion + 1);
  });

  it('a delete concurrent with a property edit on the deleted block: exactly one of the two self-consistent outcomes holds, and no row version skips a value', async () => {
    const { page, siblings } = await buildFixture('Delete vs edit, same block');
    const [target] = siblings;
    if (target === undefined) throw new Error('fixture missing a sibling');
    const basePageVersion = page.version;

    const results = await Promise.allSettled([
      updateBlockProps(deps, actor, {
        blockId: target.id,
        baseVersion: target.version,
        props: { text: 'Racing edit' },
      }),
      deleteBlock(deps, actor, {
        blockId: target.id,
        baseVersion: target.version,
        pageId: page.id,
        basePageVersion,
      }),
    ]);

    const fulfilled = fulfilledOf<unknown>(results);
    const rejected = rejectedOf(results);
    // Both writers gate on the SAME (target.id, target.version) pair, so
    // exactly one can ever pass the version-checked write -- whichever
    // acquires the row's FOR UPDATE lock first.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const [row] = await handle.sql<{ version: number }[]>`
      SELECT version FROM page_blocks WHERE id = ${target.id}
    `;
    const deleteRevisions = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM block_revisions
      WHERE block_type = 'heading' AND change_type = 'delete'
        AND owner_id = ${page.id}
    `;
    const deleteRevisionCount = Number(deleteRevisions[0]?.count ?? '0');
    const deleteWon = row === undefined;

    // Every `expect` below runs unconditionally (a ternary picks the
    // expected VALUE, it never gates whether `expect` itself runs -- oxlint's
    // `vitest/no-conditional-expect` forbids the latter, not the former).
    // The delete winning leaves the row -- and its version counter -- gone,
    // with the delete's revision recorded and the losing edit rejected with
    // some Error (its `FOR UPDATE` reload found no row). The edit winning
    // bumps the version by exactly one (never skipping straight to + 2) and
    // the delete rejects with `StaleBlockVersionError`.
    expect(row?.version ?? null).toBe(deleteWon ? null : target.version + 1);
    expect(deleteRevisionCount).toBeGreaterThanOrEqual(deleteWon ? 1 : 0);
    expect(rejected[0]).toBeInstanceOf(
      deleteWon ? Error : StaleBlockVersionError,
    );
  });

  it('the two-structural-changes race is a genuine database-level block on the page row, not a post-hoc version comparison', async () => {
    const { page, owner, section } = await buildFixture(
      'Serialisation proof: real FOR UPDATE contention',
    );

    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalHolderXid: (xid: string) => void = () => undefined;
    const holderXidReady = new Promise<string>((resolve) => {
      signalHolderXid = resolve;
    });

    const holder = handle.sql.begin(async (sql) => {
      const [row] = await sql<{ xid: string }[]>`
        SELECT pg_current_xact_id()::xid::text AS xid
        FROM pages WHERE id = ${page.id} FOR UPDATE
      `;
      signalHolderXid(row?.xid ?? '');
      await released;
    });

    let structuralPromise: Promise<unknown> | undefined;
    try {
      const holderXid = await holderXidReady;

      structuralPromise = insertBlock(deps, actor, {
        owner,
        blockType: 'heading',
        parentBlockId: section.id,
        props: { text: 'Blocked until release' },
        basePageVersion: page.version,
      }).catch((caught: unknown) => caught);

      // Scoped to the holder's own xid -- pg_locks is server-wide, and this
      // suite's sibling integration files race against the same Postgres
      // server, so an unscoped not-granted count intermittently picks up an
      // unrelated lock (STATE.md, Phase 3 decision).
      const deadline = Date.now() + 5000;
      let waiting = 0;
      while (waiting < 1 && Date.now() < deadline) {
        const [row] = await handle.sql<{ count: number }[]>`
          SELECT count(*)::int AS count FROM pg_locks
          WHERE NOT granted AND locktype = 'transactionid'
            AND transactionid = ${holderXid}::xid
        `;
        waiting = row?.count ?? 0;
      }
      expect(waiting).toBeGreaterThanOrEqual(1);
    } finally {
      release();
      await holder;
    }

    const result = await structuralPromise;
    expect(result).not.toBeInstanceOf(Error);
    expect((result as { blockType: string }).blockType).toBe('heading');
  });

  it('the same-block-edit race and the same-page-structural race each produce exactly one fulfilment at 8-way concurrency', async () => {
    const { page, owner, section, siblings } = await buildFixture(
      '8-way concurrency, not 2-way',
    );
    const [target] = siblings;
    if (target === undefined) throw new Error('fixture missing a sibling');

    const editResults = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        updateBlockProps(deps, actor, {
          blockId: target.id,
          baseVersion: target.version,
          props: { text: `Racer ${index}` },
        }),
      ),
    );
    expect(fulfilledOf(editResults)).toHaveLength(1);
    expect(rejectedOf(editResults)).toHaveLength(7);
    expect(
      rejectedOf(editResults).every(
        (reason) => reason instanceof StaleBlockVersionError,
      ),
    ).toBe(true);

    const basePageVersion = (await currentPage(page.id)).version;
    const structuralResults = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        insertBlock(deps, actor, {
          owner,
          blockType: 'heading',
          parentBlockId: section.id,
          props: { text: `Structural racer ${index}` },
          basePageVersion,
        }),
      ),
    );
    expect(fulfilledOf(structuralResults)).toHaveLength(1);
    expect(rejectedOf(structuralResults)).toHaveLength(7);
    expect(
      rejectedOf(structuralResults).every(
        (reason) => reason instanceof StalePageVersionError,
      ),
    ).toBe(true);
    expect((await currentPage(page.id)).version).toBe(basePageVersion + 1);
  });
});
