/**
 * `moveBlock`/`deleteBlock`/`computeBlockDeleteImpact` (04-06-PLAN.md
 * Task 1), proven end to end against real Postgres: whole-subtree
 * re-parenting with a single batched descendant-depth recompute, the
 * stricter subtree-height-aware placement re-check, sparse-integer sibling
 * ordering with rebalancing, and delete-keeps-history.
 */
import { randomUUID } from 'node:crypto';
import {
  createAuditRecorder,
  createUserWithRole,
  PermissionDeniedError,
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
  defineRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definePagesConfig, type PagesDeps } from '../../src/config.js';
import { createPage, getPage } from '../../src/pages.js';
import {
  BlockDepthExceededError,
  BlockPlacementError,
  SectionNestingDepthExceededError,
} from '../../src/placement.js';
import { defineBlocks } from '../../src/registry.js';
import type { BlockRecord, OwnerRef, PageRecord } from '../../src/types.js';
import {
  computeBlockDeleteImpact,
  CircularMoveError,
  deleteBlock,
  insertBlock,
  moveBlock,
  readBlockTree,
} from '../../src/tree.js';
import { createTestDatabase } from './test-database.js';

const roles = defineRoles({ ...defaultRoles, viewer: ['pages:read'] });

describe('moveBlock/deleteBlock/computeBlockDeleteImpact (D-08, D-18, D-27, D-38)', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let db: AuditDatabase;
  let deps: PagesDeps;
  let actor: AuditActor;
  let viewer: AuditActor;
  const clock = (): Date => new Date('2026-09-25T12:00:00.000Z');

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
          properties: {},
        },
        // Self-nestable (kind: 'block', but declares its own
        // allowedChildren: 'any') so a subtree with a real height > 0 can
        // be built without needing a section at every level.
        {
          key: 'wrapper',
          editor: { label: 'Wrapper' },
          schemaVersion: 1,
          properties: {},
          placement: { allowedChildren: 'any' },
        },
      ]),
      sectionNestingDepth: 2,
      blockDepthCeiling: 4,
    });

    const superadminUser = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'owner@example.com',
      name: 'Owner',
      roleKey: SUPERADMIN_ROLE_KEY,
    });
    actor = { userId: superadminUser.userId, roleKey: superadminUser.roleKey };
    const viewerUser = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'viewer@example.com',
      name: 'Viewer',
      roleKey: 'viewer',
    });
    viewer = { userId: viewerUser.userId, roleKey: viewerUser.roleKey };
    deps = { db, recorder, resolver, config, now: clock };
  });

  afterAll(async () => {
    await handle.close();
    await testDatabase.drop();
  });

  async function freshPage(title: string): Promise<PageRecord> {
    return await createPage(deps, actor, { locale: 'en', title });
  }

  function ownerOf(page: PageRecord): OwnerRef {
    return { ownerType: 'page', ownerId: page.id, locale: page.locale };
  }

  async function currentPage(pageId: string): Promise<PageRecord> {
    const page = await getPage(db, pageId);
    if (page === null) throw new Error('page vanished mid-test');
    return page;
  }

  /** Inserts a block under `parentBlockId`, always re-fetching the page's
   * current version first -- every call site in this file threads its own
   * version chain through a sequence of writes. */
  async function insert(
    page: PageRecord,
    owner: OwnerRef,
    blockType: string,
    parentBlockId: string | null,
    sortOrder?: number,
  ): Promise<BlockRecord> {
    return await insertBlock(deps, actor, {
      owner,
      blockType,
      parentBlockId,
      ...(sortOrder === undefined ? {} : { sortOrder }),
      basePageVersion: (await currentPage(page.id)).version,
    });
  }

  async function blockRow(blockId: string): Promise<{
    parentBlockId: string | null;
    depth: number;
    sortOrder: number;
    version: number;
  }> {
    const [row] = await handle.sql<
      {
        parentBlockId: string | null;
        depth: number;
        sortOrder: number;
        version: number;
      }[]
    >`
      SELECT parent_block_id AS "parentBlockId", depth, sort_order AS "sortOrder", version
      FROM page_blocks WHERE id = ${blockId}
    `;
    if (row === undefined) throw new Error(`block ${blockId} not found`);
    return row;
  }

  async function blockExists(blockId: string): Promise<boolean> {
    const [row] = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM page_blocks WHERE id = ${blockId}
    `;
    return Number(row?.count ?? '0') > 0;
  }

  async function siblingIdsInOrder(
    parentBlockId: string | null,
    ownerId: string,
  ): Promise<string[]> {
    const rows =
      parentBlockId === null
        ? await handle.sql<{ id: string }[]>`
            SELECT id FROM page_blocks
            WHERE owner_id = ${ownerId} AND parent_block_id IS NULL
            ORDER BY sort_order
          `
        : await handle.sql<{ id: string }[]>`
            SELECT id FROM page_blocks
            WHERE parent_block_id = ${parentBlockId}
            ORDER BY sort_order
          `;
    return rows.map((row) => row.id);
  }

  async function revisionRows(blockId: string): Promise<
    {
      changeType: string;
      revisionBatchId: string;
      blockType: string;
      parentBlockId: string | null;
      sortOrder: number;
      ownerType: string;
      ownerId: string;
      locale: string;
    }[]
  > {
    return await handle.sql<
      {
        changeType: string;
        revisionBatchId: string;
        blockType: string;
        parentBlockId: string | null;
        sortOrder: number;
        ownerType: string;
        ownerId: string;
        locale: string;
      }[]
    >`
      SELECT change_type AS "changeType", revision_batch_id AS "revisionBatchId",
        block_type AS "blockType", parent_block_id AS "parentBlockId",
        sort_order AS "sortOrder", owner_type AS "ownerType",
        owner_id AS "ownerId", locale
      FROM block_revisions WHERE block_id = ${blockId} ORDER BY created_at
    `;
  }

  async function revisionsByBatch(
    revisionBatchId: string,
  ): Promise<{ blockId: string | null; changeType: string }[]> {
    return await handle.sql<{ blockId: string | null; changeType: string }[]>`
      SELECT block_id AS "blockId", change_type AS "changeType"
      FROM block_revisions WHERE revision_batch_id = ${revisionBatchId}
    `;
  }

  /** `block_revisions.block_id` is `ON DELETE SET NULL` -- once a block is
   * deleted, its `'delete'`-kind revision can no longer be found by
   * `block_id`. Every `it` in this file uses a fresh page, so filtering by
   * `owner_id` + `block_type` + `change_type: 'delete'` unambiguously finds
   * the row(s) a given delete wrote. */
  async function deleteRevisionsByOwnerAndType(
    ownerId: string,
    blockType: string,
  ): Promise<
    {
      revisionBatchId: string;
      blockType: string;
      parentBlockId: string | null;
      sortOrder: number;
    }[]
  > {
    return await handle.sql<
      {
        revisionBatchId: string;
        blockType: string;
        parentBlockId: string | null;
        sortOrder: number;
      }[]
    >`
      SELECT revision_batch_id AS "revisionBatchId", block_type AS "blockType",
        parent_block_id AS "parentBlockId", sort_order AS "sortOrder"
      FROM block_revisions
      WHERE owner_id = ${ownerId} AND block_type = ${blockType}
        AND change_type = 'delete'
      ORDER BY created_at
    `;
  }

  it('moves a subtree to a new parent: children move with it, and readBlockTree nests them identically', async () => {
    const page = await freshPage('Move subtree, children follow');
    const owner = ownerOf(page);
    const sectionA = await insert(page, owner, 'section', null);
    const sectionB = await insert(page, owner, 'section', null);
    const wrapper = await insert(page, owner, 'wrapper', sectionA.id);
    const heading = await insert(page, owner, 'heading', wrapper.id);

    const moved = await moveBlock(deps, actor, {
      blockId: wrapper.id,
      baseVersion: wrapper.version,
      pageId: page.id,
      basePageVersion: (await currentPage(page.id)).version,
      newParentBlockId: sectionB.id,
    });
    expect(moved.parentBlockId).toBe(sectionB.id);

    const tree = await readBlockTree(db, owner);
    const newSectionB = tree.find((node) => node.id === sectionB.id);
    expect(newSectionB?.children).toHaveLength(1);
    const movedWrapperNode = newSectionB?.children[0];
    expect(movedWrapperNode?.id).toBe(wrapper.id);
    expect(movedWrapperNode?.children).toHaveLength(1);
    expect(movedWrapperNode?.children[0]?.id).toBe(heading.id);

    const newSectionA = tree.find((node) => node.id === sectionA.id);
    expect(newSectionA?.children).toHaveLength(0);
  });

  it("every descendant's depth equals its new distance from the root after the move (direct SELECT, not only readBlockTree)", async () => {
    const page = await freshPage('Move subtree, depths recompute');
    const owner = ownerOf(page);
    const sectionA = await insert(page, owner, 'section', null);
    const sectionB = await insert(page, owner, 'section', null);
    const wrapper = await insert(page, owner, 'wrapper', sectionA.id);
    const heading = await insert(page, owner, 'heading', wrapper.id);

    expect((await blockRow(wrapper.id)).depth).toBe(1);
    expect((await blockRow(heading.id)).depth).toBe(2);

    await moveBlock(deps, actor, {
      blockId: wrapper.id,
      baseVersion: wrapper.version,
      pageId: page.id,
      basePageVersion: (await currentPage(page.id)).version,
      newParentBlockId: sectionB.id,
    });

    expect((await blockRow(wrapper.id)).depth).toBe(1);
    expect((await blockRow(heading.id)).depth).toBe(2);

    // Move it one level deeper (under a wrapper now sitting inside sectionB)
    // to prove the depth shift is genuinely recomputed, not just "same as
    // before" by coincidence.
    const innerWrapper = await insert(page, owner, 'wrapper', sectionB.id);
    await moveBlock(deps, actor, {
      blockId: wrapper.id,
      baseVersion: (await blockRow(wrapper.id)).version,
      pageId: page.id,
      basePageVersion: (await currentPage(page.id)).version,
      newParentBlockId: innerWrapper.id,
    });
    expect((await blockRow(wrapper.id)).depth).toBe(2);
    expect((await blockRow(heading.id)).depth).toBe(3);
  });

  it('moving a section into a second section succeeds at sectionNestingDepth: 2; moving a section that already contains a section is refused', async () => {
    const page = await freshPage('Section nesting on move');
    const owner = ownerOf(page);
    // `countAncestorSections` is inclusive of the destination block itself,
    // so a plain root section (section-ancestor count 1, itself only) is
    // the destination that reaches exactly the cap (2) for a moved section
    // of height 1 (just itself) -- and, reused for the second case below,
    // is also the destination a taller moved subtree overflows.
    const sectionC = await insert(page, owner, 'section', null);
    const sectionF = await insert(page, owner, 'section', null);

    const movedF = await moveBlock(deps, actor, {
      blockId: sectionF.id,
      baseVersion: sectionF.version,
      pageId: page.id,
      basePageVersion: (await currentPage(page.id)).version,
      newParentBlockId: sectionC.id,
    });
    expect(movedF.parentBlockId).toBe(sectionC.id);
    expect((await blockRow(sectionF.id)).depth).toBe(1);

    // sectionA contains a nested sectionB -- the moved subtree's own
    // section height is 2, so moving it under sectionC (destination section
    // depth 1, inclusive of sectionC itself) would reach 3, past the cap.
    const sectionA = await insert(page, owner, 'section', null);
    const sectionB = await insert(page, owner, 'section', sectionA.id);
    const beforeA = await blockRow(sectionA.id);
    const beforeB = await blockRow(sectionB.id);

    const error: unknown = await moveBlock(deps, actor, {
      blockId: sectionA.id,
      baseVersion: sectionA.version,
      pageId: page.id,
      basePageVersion: (await currentPage(page.id)).version,
      newParentBlockId: sectionC.id,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SectionNestingDepthExceededError);
    expect((error as SectionNestingDepthExceededError).cap).toBe(2);
    expect((error as SectionNestingDepthExceededError).attempted).toBe(3);

    // Refused before anything is written.
    expect(await blockRow(sectionA.id)).toEqual(beforeA);
    expect(await blockRow(sectionB.id)).toEqual(beforeB);
  });

  it('moving a subtree past blockDepthCeiling (destination depth + subtree height) is refused; a leaf reaching the ceiling exactly succeeds', async () => {
    const page = await freshPage('Block depth ceiling on move');
    const owner = ownerOf(page);
    const section = await insert(page, owner, 'section', null); // depth 0
    const w1 = await insert(page, owner, 'wrapper', section.id); // depth 1
    const w2 = await insert(page, owner, 'wrapper', w1.id); // depth 2
    const w3 = await insert(page, owner, 'wrapper', w2.id); // depth 3

    // A leaf moved to depth 4 (== ceiling) succeeds.
    const headingZ = await insert(page, owner, 'heading', section.id); // depth 1
    const movedLeaf = await moveBlock(deps, actor, {
      blockId: headingZ.id,
      baseVersion: headingZ.version,
      pageId: page.id,
      basePageVersion: (await currentPage(page.id)).version,
      newParentBlockId: w3.id,
    });
    expect((await blockRow(movedLeaf.id)).depth).toBe(4);

    // A subtree of height 1 (wrapperX + a child heading) moved under w3
    // would place its deepest node at depth 5 -- refused even though
    // wrapperX alone would fit at depth 4 (proves the subtree-height term,
    // not just the moved node's own depth, is what's checked).
    const wrapperX = await insert(page, owner, 'wrapper', section.id); // depth 1
    const headingY = await insert(page, owner, 'heading', wrapperX.id); // depth 2
    const beforeX = await blockRow(wrapperX.id);
    const beforeY = await blockRow(headingY.id);

    const error: unknown = await moveBlock(deps, actor, {
      blockId: wrapperX.id,
      baseVersion: wrapperX.version,
      pageId: page.id,
      basePageVersion: (await currentPage(page.id)).version,
      newParentBlockId: w3.id,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BlockDepthExceededError);
    expect((error as BlockDepthExceededError).ceiling).toBe(4);
    expect((error as BlockDepthExceededError).attempted).toBe(5);

    expect(await blockRow(wrapperX.id)).toEqual(beforeX);
    expect(await blockRow(headingY.id)).toEqual(beforeY);
  });

  it('moving a block into a parent whose allowedChildren rejects it throws BlockPlacementError and writes nothing', async () => {
    const page = await freshPage('Parent rejects child on move');
    const owner = ownerOf(page);
    const section = await insert(page, owner, 'section', null);
    const headingParent = await insert(page, owner, 'heading', section.id);
    const wrapper = await insert(page, owner, 'wrapper', section.id);
    const before = await blockRow(wrapper.id);

    const error: unknown = await moveBlock(deps, actor, {
      blockId: wrapper.id,
      baseVersion: wrapper.version,
      pageId: page.id,
      basePageVersion: (await currentPage(page.id)).version,
      newParentBlockId: headingParent.id,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BlockPlacementError);
    expect((error as BlockPlacementError).reason).toBe('parent-rejects-child');
    expect(await blockRow(wrapper.id)).toEqual(before);
  });

  it('moving a block into its own descendant throws CircularMoveError and writes nothing', async () => {
    const page = await freshPage('Circular move refused');
    const owner = ownerOf(page);
    const section = await insert(page, owner, 'section', null);
    const wrapper = await insert(page, owner, 'wrapper', section.id);
    const heading = await insert(page, owner, 'heading', wrapper.id);
    const before = await blockRow(wrapper.id);

    const errorIntoChild: unknown = await moveBlock(deps, actor, {
      blockId: wrapper.id,
      baseVersion: wrapper.version,
      pageId: page.id,
      basePageVersion: (await currentPage(page.id)).version,
      newParentBlockId: heading.id,
    }).catch((caught: unknown) => caught);
    expect(errorIntoChild).toBeInstanceOf(CircularMoveError);

    const errorIntoSelf: unknown = await moveBlock(deps, actor, {
      blockId: wrapper.id,
      baseVersion: wrapper.version,
      pageId: page.id,
      basePageVersion: (await currentPage(page.id)).version,
      newParentBlockId: wrapper.id,
    }).catch((caught: unknown) => caught);
    expect(errorIntoSelf).toBeInstanceOf(CircularMoveError);

    expect(await blockRow(wrapper.id)).toEqual(before);
  });

  it('moving into a position between two siblings whose orders differ by 1 triggers exactly one rebalance, leaving the visible order correct', async () => {
    const page = await freshPage('Rebalance on move');
    const owner = ownerOf(page);
    const section = await insert(page, owner, 'section', null);
    const first = await insert(page, owner, 'heading', section.id, 1000);
    const second = await insert(page, owner, 'heading', section.id, 1001);
    const elsewhere = await insert(page, owner, 'section', null);
    const moving = await insert(page, owner, 'heading', elsewhere.id);

    await moveBlock(deps, actor, {
      blockId: moving.id,
      baseVersion: moving.version,
      pageId: page.id,
      basePageVersion: (await currentPage(page.id)).version,
      newParentBlockId: section.id,
      beforeSiblingId: first.id,
      afterSiblingId: second.id,
    });

    const orderedIds = await siblingIdsInOrder(section.id, page.id);
    expect(orderedIds).toEqual([first.id, moving.id, second.id]);

    // Evidence a rebalance actually ran: every sibling now sits on a clean
    // SORT_ORDER_STEP multiple, not the pre-rebalance 1000/1001 pair.
    const firstRow = await blockRow(first.id);
    const movingRow = await blockRow(moving.id);
    const secondRow = await blockRow(second.id);
    expect(firstRow.sortOrder % 1000).toBe(0);
    expect(secondRow.sortOrder % 1000).toBe(0);
    expect(movingRow.sortOrder).toBeGreaterThan(firstRow.sortOrder);
    expect(movingRow.sortOrder).toBeLessThan(secondRow.sortOrder);
  });

  it('deleting a block with two descendants removes three rows and writes three delete-kind revisions sharing one revision_batch_id', async () => {
    const page = await freshPage('Delete subtree, three revisions');
    const owner = ownerOf(page);
    const section = await insert(page, owner, 'section', null);
    const wrapper = await insert(page, owner, 'wrapper', section.id);
    const headingA = await insert(page, owner, 'heading', wrapper.id);
    const headingB = await insert(page, owner, 'heading', wrapper.id);

    const preWrapper = await blockRow(wrapper.id);
    const preHeadingA = await blockRow(headingA.id);
    const preHeadingB = await blockRow(headingB.id);

    const impact = await deleteBlock(deps, actor, {
      blockId: wrapper.id,
      baseVersion: wrapper.version,
      pageId: page.id,
      basePageVersion: (await currentPage(page.id)).version,
    });
    expect(impact.blockCount).toBe(3);
    expect([...impact.blockTypes].sort()).toEqual(['heading', 'wrapper']);

    expect(await blockExists(wrapper.id)).toBe(false);
    expect(await blockExists(headingA.id)).toBe(false);
    expect(await blockExists(headingB.id)).toBe(false);

    const wrapperDeleteRevisions = await deleteRevisionsByOwnerAndType(
      owner.ownerId,
      'wrapper',
    );
    expect(wrapperDeleteRevisions).toHaveLength(1);
    const deleteRevision = wrapperDeleteRevisions[0];
    expect(deleteRevision?.blockType).toBe('wrapper');
    expect(deleteRevision?.parentBlockId).toBe(preWrapper.parentBlockId);
    expect(deleteRevision?.sortOrder).toBe(preWrapper.sortOrder);

    const batchRows = await revisionsByBatch(
      deleteRevision?.revisionBatchId ?? '',
    );
    expect(batchRows).toHaveLength(3);
    expect(batchRows.every((row) => row.changeType === 'delete')).toBe(true);
    expect(batchRows.every((row) => row.blockId === null)).toBe(true);

    const headingDeleteRevisions = await deleteRevisionsByOwnerAndType(
      owner.ownerId,
      'heading',
    );
    expect(headingDeleteRevisions).toHaveLength(2);
    const numericAsc = (a: number, b: number): number => a - b;
    const sortOrders = headingDeleteRevisions
      .map((row) => row.sortOrder)
      .sort(numericAsc);
    expect(sortOrders).toEqual(
      [preHeadingA.sortOrder, preHeadingB.sortOrder].sort(numericAsc),
    );
    expect(
      headingDeleteRevisions.every((row) => row.parentBlockId === wrapper.id),
    ).toBe(true);
  });

  it("after a delete, the removed blocks' earlier revisions are still present with block_id null and owner/locale intact", async () => {
    const page = await freshPage('Delete keeps history');
    const owner = ownerOf(page);
    const section = await insert(page, owner, 'section', null);
    const heading = await insert(page, owner, 'heading', section.id);
    const headingId = heading.id;

    const beforeCreateRevisions = await revisionRows(headingId);
    expect(beforeCreateRevisions).toHaveLength(1);
    expect(beforeCreateRevisions[0]?.changeType).toBe('create');

    await deleteBlock(deps, actor, {
      blockId: headingId,
      baseVersion: heading.version,
      pageId: page.id,
      basePageVersion: (await currentPage(page.id)).version,
    });

    const [createRow] = await handle.sql<
      {
        blockId: string | null;
        changeType: string;
        ownerType: string;
        ownerId: string;
        locale: string;
      }[]
    >`
      SELECT block_id AS "blockId", change_type AS "changeType",
        owner_type AS "ownerType", owner_id AS "ownerId", locale
      FROM block_revisions WHERE change_type = 'create'
      AND owner_id = ${owner.ownerId} AND block_type = 'heading'
      ORDER BY created_at LIMIT 1
    `;
    expect(createRow?.blockId).toBeNull();
    expect(createRow?.ownerType).toBe('page');
    expect(createRow?.ownerId).toBe(owner.ownerId);
    expect(createRow?.locale).toBe('en');
  });

  it('computeBlockDeleteImpact reports the block count and block types about to be removed, and writes nothing', async () => {
    const page = await freshPage('computeBlockDeleteImpact preview');
    const owner = ownerOf(page);
    const section = await insert(page, owner, 'section', null);
    const wrapper = await insert(page, owner, 'wrapper', section.id);
    const headingA = await insert(page, owner, 'heading', wrapper.id);

    const beforeVersion = (await currentPage(page.id)).version;
    const beforeExistsWrapper = await blockExists(wrapper.id);
    const beforeExistsHeadingA = await blockExists(headingA.id);

    const impact = await computeBlockDeleteImpact(db, { blockId: wrapper.id });
    expect(impact.blockCount).toBe(2);
    expect([...impact.blockTypes].sort()).toEqual(['heading', 'wrapper']);

    expect((await currentPage(page.id)).version).toBe(beforeVersion);
    expect(await blockExists(wrapper.id)).toBe(beforeExistsWrapper);
    expect(await blockExists(headingA.id)).toBe(beforeExistsHeadingA);
  });

  it('a stale baseVersion refuses a move with StaleBlockVersionError; a stale basePageVersion refuses with StalePageVersionError; a stale baseVersion refuses a delete', async () => {
    const page = await freshPage('Stale versions refused');
    const owner = ownerOf(page);
    const section = await insert(page, owner, 'section', null);
    const heading = await insert(page, owner, 'heading', section.id);

    const staleBlockError: unknown = await moveBlock(deps, actor, {
      blockId: heading.id,
      baseVersion: heading.version + 1,
      pageId: page.id,
      basePageVersion: (await currentPage(page.id)).version,
      newParentBlockId: null,
    }).catch((caught: unknown) => caught);
    expect((staleBlockError as Error).name).toBe('StaleBlockVersionError');

    const stalePageError: unknown = await moveBlock(deps, actor, {
      blockId: heading.id,
      baseVersion: heading.version,
      pageId: page.id,
      basePageVersion: (await currentPage(page.id)).version + 1,
      newParentBlockId: null,
    }).catch((caught: unknown) => caught);
    expect((stalePageError as Error).name).toBe('StalePageVersionError');

    const staleDeleteError: unknown = await deleteBlock(deps, actor, {
      blockId: heading.id,
      baseVersion: heading.version + 1,
      pageId: page.id,
      basePageVersion: (await currentPage(page.id)).version,
    }).catch((caught: unknown) => caught);
    expect((staleDeleteError as Error).name).toBe('StaleBlockVersionError');
  });

  it('move and delete run through deps.recorder.run gated on pages:edit/pages:delete: a refused call writes a denied audit row and no data', async () => {
    const page = await freshPage('Move/delete permission gating');
    const owner = ownerOf(page);
    const section = await insert(page, owner, 'section', null);
    const heading = await insert(page, owner, 'heading', section.id);
    const beforeMove = await blockRow(heading.id);

    const moveDenied: unknown = await moveBlock(deps, viewer, {
      blockId: heading.id,
      baseVersion: heading.version,
      pageId: page.id,
      basePageVersion: (await currentPage(page.id)).version,
      newParentBlockId: null,
    }).catch((caught: unknown) => caught);
    expect(moveDenied).toBeInstanceOf(PermissionDeniedError);
    expect(await blockRow(heading.id)).toEqual(beforeMove);

    const deleteDenied: unknown = await deleteBlock(deps, viewer, {
      blockId: heading.id,
      baseVersion: heading.version,
      pageId: page.id,
      basePageVersion: (await currentPage(page.id)).version,
    }).catch((caught: unknown) => caught);
    expect(deleteDenied).toBeInstanceOf(PermissionDeniedError);
    expect(await blockExists(heading.id)).toBe(true);
    expect(await blockRow(heading.id)).toEqual(beforeMove);

    const deniedRows = await handle.sql<{ action: string }[]>`
      SELECT action FROM audit_log
      WHERE outcome = 'denied' AND actor_user_id = ${viewer.userId}
      ORDER BY id
    `;
    expect(deniedRows.map((row) => row.action)).toEqual([
      'block.move',
      'block.delete',
    ]);
  });
});
