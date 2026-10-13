/**
 * `applyBlockEdit` (D-25), proven end to end against real Postgres: a batch
 * of structural and property operations lands as one transaction, one
 * revision batch, one audit row and one page version bump, every id it names
 * is checked against the page it was sent for, and a refused batch leaves
 * nothing behind.
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
import type { CacheInvalidator } from '@plakboek/cache';
import {
  createPermissionResolver,
  defaultRoles,
  defineRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definePagesConfig, type PagesDeps } from '../../src/config.js';
import {
  applyBlockEdit,
  BLOCK_EDIT_MAX_NODES,
  BLOCK_EDIT_MAX_OPS,
  BlockEditLimitError,
  BlockIdConflictError,
  BlockOwnershipError,
  type BlockEditOp,
} from '../../src/edit-batch.js';
import { createPage, getPage, StalePageVersionError } from '../../src/pages.js';
import { BlockPlacementError } from '../../src/placement.js';
import { publishPage } from '../../src/publish.js';
import { defineBlocks } from '../../src/registry.js';
import {
  BlockNotFoundError,
  insertBlock,
  readBlockTree,
  StaleBlockVersionError,
} from '../../src/tree.js';
import type { BlockRecord, OwnerRef, PageRecord } from '../../src/types.js';
import { createTestDatabase } from './test-database.js';

const roles = defineRoles({
  ...defaultRoles,
  'edit-only': ['pages:read', 'pages:edit'],
});

describe('applyBlockEdit (D-25)', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let db: AuditDatabase;
  let deps: PagesDeps;
  let actor: AuditActor;
  let editOnly: AuditActor;
  const clock = (): Date => new Date('2026-10-13T14:00:00.000Z');

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
          key: 'column',
          kind: 'column',
          editor: { label: 'Column' },
          schemaVersion: 1,
          properties: {},
        },
        {
          key: 'section',
          kind: 'section',
          editor: { label: 'Section' },
          schemaVersion: 1,
          properties: {},
        },
        {
          key: 'text',
          editor: { label: 'Text' },
          schemaVersion: 1,
          properties: {
            value: {
              fieldType: 'short_text',
              label: 'Value',
              required: true,
              options: { maxLength: 80 },
            },
          },
        },
        {
          key: 'quote',
          editor: { label: 'Quote' },
          schemaVersion: 1,
          properties: {},
          layout: { fill: true },
        },
      ]),
      sectionNestingDepth: 2,
      blockDepthCeiling: 12,
    });

    const user = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'edit-batch@example.com',
      name: 'Batch',
      roleKey: SUPERADMIN_ROLE_KEY,
    });
    actor = { userId: user.userId, roleKey: user.roleKey };
    const editOnlyUser = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'edit-only@example.com',
      name: 'Edit only',
      roleKey: 'edit-only',
    });
    editOnly = { userId: editOnlyUser.userId, roleKey: editOnlyUser.roleKey };
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

  async function add(
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

  type Fixture = {
    readonly page: PageRecord;
    readonly section: BlockRecord;
    readonly column: BlockRecord;
    readonly text: BlockRecord;
  };

  /** A page holding one section, one column and one text. */
  async function buildFixture(title: string): Promise<Fixture> {
    const page = await createPage(deps, actor, { locale: 'en', title });
    const section = await add(page, 'section', null);
    const column = await add(page, 'column', section.id);
    const text = await add(page, 'text', column.id, { value: 'Original' });
    return { page: await currentPage(page.id), section, column, text };
  }

  async function blockCount(pageId: string): Promise<number> {
    const [row] = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM page_blocks WHERE owner_id = ${pageId}
    `;
    return Number(row?.count ?? '0');
  }

  async function revisionCount(pageId: string): Promise<number> {
    const [row] = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM block_revisions
      WHERE owner_id = ${pageId}
    `;
    return Number(row?.count ?? '0');
  }

  async function revisionsOfBatch(
    revisionBatchId: string,
  ): Promise<{ blockId: string | null; changeType: string }[]> {
    return await handle.sql<{ blockId: string | null; changeType: string }[]>`
      SELECT block_id AS "blockId", change_type AS "changeType"
      FROM block_revisions WHERE revision_batch_id = ${revisionBatchId}
    `;
  }

  async function auditCount(
    pageId: string,
    outcome: 'allowed' | 'denied' = 'allowed',
  ): Promise<number> {
    const [row] = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log
      WHERE action = 'block.edit' AND entity_id = ${pageId}
        AND outcome = ${outcome}
    `;
    return Number(row?.count ?? '0');
  }

  it('inserts a section with a column and a text under client ids and updates another block, as one revision batch and one version bump', async () => {
    const { page, section, text } = await buildFixture('Batch insert + update');
    const sectionId = randomUUID();
    const columnId = randomUUID();
    const textId = randomUUID();
    const auditBefore = await auditCount(page.id);

    const result = await applyBlockEdit(deps, actor, {
      pageId: page.id,
      basePageVersion: page.version,
      ops: [
        {
          op: 'insert',
          position: { parentId: null, previousSiblingId: section.id },
          node: {
            id: sectionId,
            type: 'section',
            layout: { columns: '2:1' },
            children: [
              {
                id: columnId,
                type: 'column',
                children: [
                  { id: textId, type: 'text', props: { value: 'Hello' } },
                ],
              },
            ],
          },
        },
        {
          op: 'update',
          blockId: text.id,
          baseVersion: text.version,
          props: { value: 'Changed' },
        },
      ],
    });

    expect(result.createdIds).toEqual([sectionId, columnId, textId]);
    expect(result.updatedIds).toEqual([text.id]);
    expect(result.pageVersion).toBe(page.version + 1);
    expect(result.touchedParentIds).toEqual([null]);
    expect((await currentPage(page.id)).version).toBe(page.version + 1);

    const tree = await readBlockTree(db, ownerOf(page));
    expect(tree.map((node) => node.id)).toEqual([section.id, sectionId]);
    const inserted = tree[1];
    expect(inserted?.layout).toEqual({ columns: '2:1' });
    expect(inserted?.children[0]?.id).toBe(columnId);
    expect(inserted?.children[0]?.children[0]).toMatchObject({
      id: textId,
      props: { value: 'Hello' },
    });
    expect(tree[0]?.children[0]?.children[0]).toMatchObject({
      id: text.id,
      props: { value: 'Changed' },
      version: text.version + 1,
    });

    const revisions = await revisionsOfBatch(result.revisionBatchId);
    expect(revisions).toHaveLength(4);
    expect(
      revisions.filter((revision) => revision.changeType === 'create'),
    ).toHaveLength(3);
    expect(
      revisions.filter((revision) => revision.changeType === 'update'),
    ).toEqual([{ blockId: text.id, changeType: 'update' }]);
    expect(await auditCount(page.id)).toBe(auditBefore + 1);
  });

  it('places an inserted section between the two siblings it names', async () => {
    const { page, section } = await buildFixture('Batch insert position');
    const last = await add(page, 'section', null);
    const middleId = randomUUID();

    await applyBlockEdit(deps, actor, {
      pageId: page.id,
      basePageVersion: (await currentPage(page.id)).version,
      ops: [
        {
          op: 'insert',
          position: {
            parentId: null,
            previousSiblingId: section.id,
            nextSiblingId: last.id,
          },
          node: { id: middleId, type: 'section' },
        },
      ],
    });

    const tree = await readBlockTree(db, ownerOf(page));
    expect(tree.map((node) => node.id)).toEqual([
      section.id,
      middleId,
      last.id,
    ]);
  });

  it('accepts a text with no value (D-21)', async () => {
    const { page, column } = await buildFixture('Batch empty required');
    const result = await applyBlockEdit(deps, actor, {
      pageId: page.id,
      basePageVersion: page.version,
      ops: [
        {
          op: 'insert',
          position: { parentId: column.id },
          node: { type: 'text' },
        },
      ],
    });
    expect(result.createdIds).toHaveLength(1);
    const [row] = await handle.sql<{ props: unknown }[]>`
      SELECT props FROM page_blocks WHERE id = ${result.createdIds[0] ?? ''}
    `;
    expect(row?.props).toEqual({});
  });

  it('refuses a batch whose later operation names a block of another page, writing nothing to either page', async () => {
    const first = await buildFixture('Batch ownership A');
    const second = await buildFixture('Batch ownership B');
    const blocksBefore = await blockCount(first.page.id);
    const revisionsBefore = await revisionCount(first.page.id);
    const auditBefore = await auditCount(first.page.id);

    const error: unknown = await applyBlockEdit(deps, actor, {
      pageId: first.page.id,
      basePageVersion: first.page.version,
      ops: [
        {
          op: 'insert',
          position: { parentId: null },
          node: { type: 'section' },
        },
        {
          op: 'update',
          blockId: second.text.id,
          baseVersion: second.text.version,
          props: { value: 'Smuggled' },
        },
      ],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BlockOwnershipError);
    expect((error as BlockOwnershipError).blockId).toBe(second.text.id);
    expect(await blockCount(first.page.id)).toBe(blocksBefore);
    expect(await revisionCount(first.page.id)).toBe(revisionsBefore);
    expect((await currentPage(first.page.id)).version).toBe(first.page.version);
    expect((await currentPage(second.page.id)).version).toBe(
      second.page.version,
    );
    const [untouched] = await handle.sql<{ props: { value: string } }[]>`
      SELECT props FROM page_blocks WHERE id = ${second.text.id}
    `;
    expect(untouched?.props.value).toBe('Original');
    expect(await auditCount(first.page.id)).toBe(auditBefore);
  });

  it('refuses a block that does not exist before writing anything', async () => {
    const { page } = await buildFixture('Batch missing block');
    const blocksBefore = await blockCount(page.id);
    const ops: BlockEditOp[] = [
      {
        op: 'insert',
        position: { parentId: null },
        node: { type: 'section' },
      },
      {
        op: 'update',
        blockId: randomUUID(),
        baseVersion: 1,
        props: { value: 'x' },
      },
    ];
    await expect(
      applyBlockEdit(deps, actor, {
        pageId: page.id,
        basePageVersion: page.version,
        ops,
      }),
    ).rejects.toMatchObject({ name: 'BlockNotFoundError' });
    expect(await blockCount(page.id)).toBe(blocksBefore);
  });

  it('writes nothing when the base page version is stale', async () => {
    const { page } = await buildFixture('Batch stale page');
    const blocksBefore = await blockCount(page.id);
    const revisionsBefore = await revisionCount(page.id);

    await expect(
      applyBlockEdit(deps, actor, {
        pageId: page.id,
        basePageVersion: page.version - 1,
        ops: [
          {
            op: 'insert',
            position: { parentId: null },
            node: { type: 'section' },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(StalePageVersionError);

    expect(await blockCount(page.id)).toBe(blocksBefore);
    expect(await revisionCount(page.id)).toBe(revisionsBefore);
    expect((await currentPage(page.id)).version).toBe(page.version);
  });

  /** A page holding two sections, each with a column; the first column holds
   * a text, and a third section (with its own column and text) is the one
   * the delete cases remove. */
  type MoveDeleteFixture = {
    readonly page: PageRecord;
    readonly columnA: BlockRecord;
    readonly columnB: BlockRecord;
    readonly text: BlockRecord;
    readonly doomed: BlockRecord;
    readonly doomedColumn: BlockRecord;
    readonly doomedText: BlockRecord;
  };

  async function buildMoveDeleteFixture(
    title: string,
  ): Promise<MoveDeleteFixture> {
    const page = await createPage(deps, actor, { locale: 'en', title });
    const sectionA = await add(page, 'section', null);
    const columnA = await add(page, 'column', sectionA.id);
    const text = await add(page, 'text', columnA.id, { value: 'Moving' });
    const sectionB = await add(page, 'section', null);
    const columnB = await add(page, 'column', sectionB.id);
    const doomed = await add(page, 'section', null);
    const doomedColumn = await add(page, 'column', doomed.id);
    const doomedText = await add(page, 'text', doomedColumn.id, {
      value: 'Doomed',
    });
    return {
      page: await currentPage(page.id),
      columnA,
      columnB,
      text,
      doomed,
      doomedColumn,
      doomedText,
    };
  }

  async function deleteRevisionCount(
    ownerId: string,
    blockType: string,
  ): Promise<number> {
    const [row] = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM block_revisions
      WHERE owner_id = ${ownerId} AND change_type = 'delete'
        AND block_type = ${blockType}
    `;
    return Number(row?.count ?? '0');
  }

  it('moves a text across a section boundary and deletes another section in one batch: one batch id, one version bump', async () => {
    const f = await buildMoveDeleteFixture('Batch move + delete');

    const result = await applyBlockEdit(deps, actor, {
      pageId: f.page.id,
      basePageVersion: f.page.version,
      ops: [
        {
          op: 'move',
          blockId: f.text.id,
          baseVersion: f.text.version,
          position: { parentId: f.columnB.id },
        },
        {
          op: 'delete',
          blockId: f.doomed.id,
          baseVersion: f.doomed.version,
        },
      ],
    });

    expect(result.pageVersion).toBe(f.page.version + 1);
    expect(result.movedIds).toEqual([f.text.id]);
    expect(result.deletedIds).toEqual([
      f.doomed.id,
      f.doomedColumn.id,
      f.doomedText.id,
    ]);
    expect(new Set(result.touchedParentIds)).toEqual(
      new Set([f.columnA.id, f.columnB.id, null]),
    );

    const tree = await readBlockTree(db, ownerOf(f.page));
    expect(tree).toHaveLength(2);
    expect(tree[0]?.children[0]?.children).toHaveLength(0);
    expect(tree[1]?.children[0]?.children[0]?.id).toBe(f.text.id);

    const revisions = await revisionsOfBatch(result.revisionBatchId);
    expect(
      revisions.filter((revision) => revision.changeType === 'move'),
    ).toHaveLength(1);
    expect(
      revisions.filter((revision) => revision.changeType === 'delete'),
    ).toHaveLength(3);
    expect((await currentPage(f.page.id)).version).toBe(f.page.version + 1);
  });

  it('lets a block be updated and then moved in one batch, both against the version the client saw', async () => {
    const f = await buildMoveDeleteFixture('Batch update then move');

    const result = await applyBlockEdit(deps, actor, {
      pageId: f.page.id,
      basePageVersion: f.page.version,
      ops: [
        {
          op: 'update',
          blockId: f.text.id,
          baseVersion: f.text.version,
          props: { value: 'Both' },
        },
        {
          op: 'move',
          blockId: f.text.id,
          baseVersion: f.text.version,
          position: { parentId: f.columnB.id },
        },
      ],
    });
    expect(result.updatedIds).toEqual([f.text.id]);
    expect(result.movedIds).toEqual([f.text.id]);

    await expect(
      applyBlockEdit(deps, actor, {
        pageId: f.page.id,
        basePageVersion: result.pageVersion,
        ops: [
          {
            op: 'update',
            blockId: f.text.id,
            baseVersion: f.text.version,
            props: { value: 'Stale' },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(StaleBlockVersionError);
  });

  it('refuses a move that breaks placement, rolling the earlier operations back', async () => {
    const f = await buildMoveDeleteFixture('Batch placement refusal');
    const blocksBefore = await blockCount(f.page.id);

    const error: unknown = await applyBlockEdit(deps, actor, {
      pageId: f.page.id,
      basePageVersion: f.page.version,
      ops: [
        {
          op: 'update',
          blockId: f.text.id,
          baseVersion: f.text.version,
          props: { value: 'Rolled back' },
        },
        {
          op: 'move',
          blockId: f.text.id,
          baseVersion: f.text.version,
          position: { parentId: f.doomed.id },
        },
      ],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BlockPlacementError);
    expect(await blockCount(f.page.id)).toBe(blocksBefore);
    const [row] = await handle.sql<{ props: { value: string } }[]>`
      SELECT props FROM page_blocks WHERE id = ${f.text.id}
    `;
    expect(row?.props.value).toBe('Moving');
    expect((await currentPage(f.page.id)).version).toBe(f.page.version);
  });

  it('refuses an operation that names a block an earlier operation of the batch deleted', async () => {
    const f = await buildMoveDeleteFixture('Batch deleted reference');

    await expect(
      applyBlockEdit(deps, actor, {
        pageId: f.page.id,
        basePageVersion: f.page.version,
        ops: [
          {
            op: 'delete',
            blockId: f.doomed.id,
            baseVersion: f.doomed.version,
          },
          {
            op: 'update',
            blockId: f.doomedText.id,
            baseVersion: f.doomedText.version,
            props: { value: 'Gone' },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BlockNotFoundError);
    expect(await blockCount(f.page.id)).toBe(8);
  });

  it('refuses an empty batch, too many operations and too many inserted blocks before any query', async () => {
    const { page } = await buildFixture('Batch limits');
    const insertSection = (): BlockEditOp => ({
      op: 'insert',
      position: { parentId: null },
      node: { type: 'section' },
    });

    const limitOf = async (ops: readonly BlockEditOp[]): Promise<unknown> => {
      const error: unknown = await applyBlockEdit(deps, actor, {
        pageId: page.id,
        basePageVersion: page.version,
        ops,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BlockEditLimitError);
      return (error as BlockEditLimitError).limit;
    };

    expect(await limitOf([])).toBe('empty');
    expect(
      await limitOf(
        Array.from({ length: BLOCK_EDIT_MAX_OPS + 1 }, insertSection),
      ),
    ).toBe('ops');
    expect(
      await limitOf([
        {
          op: 'insert',
          position: { parentId: null },
          node: {
            type: 'section',
            children: Array.from({ length: BLOCK_EDIT_MAX_NODES }, () => ({
              type: 'column',
            })),
          },
        },
      ]),
    ).toBe('nodes');
    expect((await currentPage(page.id)).version).toBe(page.version);
  });

  it('refuses a batch holding a delete when the role may edit but not delete, recording the refusal and writing nothing', async () => {
    const f = await buildMoveDeleteFixture('Batch delete permission');
    const blocksBefore = await blockCount(f.page.id);
    const revisionsBefore = await revisionCount(f.page.id);
    const allowedBefore = await auditCount(f.page.id);

    const error: unknown = await applyBlockEdit(deps, editOnly, {
      pageId: f.page.id,
      basePageVersion: f.page.version,
      ops: [
        {
          op: 'move',
          blockId: f.text.id,
          baseVersion: f.text.version,
          position: { parentId: f.columnB.id },
        },
        {
          op: 'delete',
          blockId: f.doomed.id,
          baseVersion: f.doomed.version,
        },
      ],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect((error as PermissionDeniedError).permission).toBe('pages:delete');
    expect(await blockCount(f.page.id)).toBe(blocksBefore);
    expect(await revisionCount(f.page.id)).toBe(revisionsBefore);
    expect((await currentPage(f.page.id)).version).toBe(f.page.version);
    expect(await auditCount(f.page.id, 'denied')).toBe(1);
    expect(await auditCount(f.page.id)).toBe(allowedBefore);

    const moveOnly = await applyBlockEdit(deps, editOnly, {
      pageId: f.page.id,
      basePageVersion: f.page.version,
      ops: [
        {
          op: 'move',
          blockId: f.text.id,
          baseVersion: f.text.version,
          position: { parentId: f.columnB.id },
        },
      ],
    });
    expect(moveOnly.movedIds).toEqual([f.text.id]);
  });

  it('refuses a re-sent delete of a section that is already gone, adding no second delete batch (BLOCK-02 idempotency)', async () => {
    const f = await buildMoveDeleteFixture('Batch delete idempotency');
    const first = await applyBlockEdit(deps, actor, {
      pageId: f.page.id,
      basePageVersion: f.page.version,
      ops: [
        { op: 'delete', blockId: f.doomed.id, baseVersion: f.doomed.version },
      ],
    });
    const revisionsAfterFirst = await revisionCount(f.page.id);

    // A second tab that has since refreshed its page version.
    const error: unknown = await applyBlockEdit(deps, actor, {
      pageId: f.page.id,
      basePageVersion: first.pageVersion,
      ops: [
        { op: 'delete', blockId: f.doomed.id, baseVersion: f.doomed.version },
      ],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BlockNotFoundError);
    expect(await revisionCount(f.page.id)).toBe(revisionsAfterFirst);
    expect((await currentPage(f.page.id)).version).toBe(first.pageVersion);
    expect(await deleteRevisionCount(f.page.id, 'section')).toBe(1);
  });

  it('lets exactly one of two concurrent batches delete the same section, recording its subtree once (BLOCK-02 concurrency)', async () => {
    const f = await buildMoveDeleteFixture('Batch delete race');
    const deleteDoomed = (): Promise<unknown> =>
      applyBlockEdit(deps, actor, {
        pageId: f.page.id,
        basePageVersion: f.page.version,
        ops: [
          {
            op: 'delete',
            blockId: f.doomed.id,
            baseVersion: f.doomed.version,
          },
        ],
      });

    const results = await Promise.allSettled([deleteDoomed(), deleteDoomed()]);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      rejected[0]?.reason instanceof StalePageVersionError ||
        rejected[0]?.reason instanceof BlockNotFoundError,
    ).toBe(true);

    expect(await deleteRevisionCount(f.page.id, 'section')).toBe(1);
    expect(await deleteRevisionCount(f.page.id, 'column')).toBe(1);
    expect(await deleteRevisionCount(f.page.id, 'text')).toBe(1);
  });

  it('refuses a re-sent insert under an id that exists, creating no second block (BLOCK-04 idempotency)', async () => {
    const { page } = await buildFixture('Batch insert idempotency');
    const sectionId = randomUUID();
    const insert: BlockEditOp = {
      op: 'insert',
      position: { parentId: null },
      node: { id: sectionId, type: 'section' },
    };
    const first = await applyBlockEdit(deps, actor, {
      pageId: page.id,
      basePageVersion: page.version,
      ops: [insert],
    });
    const blocksAfterFirst = await blockCount(page.id);

    const error: unknown = await applyBlockEdit(deps, actor, {
      pageId: page.id,
      basePageVersion: first.pageVersion,
      ops: [insert],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BlockIdConflictError);
    expect((error as BlockIdConflictError).blockId).toBe(sectionId);
    expect(await blockCount(page.id)).toBe(blocksAfterFirst);
    expect((await currentPage(page.id)).version).toBe(first.pageVersion);
  });

  it('refuses a batch that supplies one id twice', async () => {
    const { page } = await buildFixture('Batch duplicate client id');
    const id = randomUUID();
    const error: unknown = await applyBlockEdit(deps, actor, {
      pageId: page.id,
      basePageVersion: page.version,
      ops: [
        {
          op: 'insert',
          position: { parentId: null },
          node: { id, type: 'section' },
        },
        {
          op: 'insert',
          position: { parentId: null },
          node: { id, type: 'section' },
        },
      ],
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BlockIdConflictError);
    expect((await currentPage(page.id)).version).toBe(page.version);
  });

  it('lets exactly one of two concurrent inserts on one base page version commit (BLOCK-04 concurrency)', async () => {
    const { page } = await buildFixture('Batch insert race');
    const blocksBefore = await blockCount(page.id);
    const insertSection = (): Promise<unknown> =>
      applyBlockEdit(deps, actor, {
        pageId: page.id,
        basePageVersion: page.version,
        ops: [
          {
            op: 'insert',
            position: { parentId: null },
            node: { type: 'section' },
          },
        ],
      });

    const results = await Promise.allSettled([
      insertSection(),
      insertSection(),
    ]);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(StalePageVersionError);
    // One committed section plus the column every new section starts with.
    expect(await blockCount(page.id)).toBe(blocksBefore + 2);
    expect((await currentPage(page.id)).version).toBe(page.version + 1);
  });

  it('records a delete revision carrying props and layout for every block of a deleted subtree before the rows go', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Batch delete recoverable',
    });
    const sectionId = randomUUID();
    const columnId = randomUUID();
    const textId = randomUUID();
    const created = await applyBlockEdit(deps, actor, {
      pageId: page.id,
      basePageVersion: page.version,
      ops: [
        {
          op: 'insert',
          position: { parentId: null },
          node: {
            id: sectionId,
            type: 'section',
            layout: { columns: '2:1', align: 'center' },
            children: [
              {
                id: columnId,
                type: 'column',
                children: [
                  { id: textId, type: 'text', props: { value: 'Keep me' } },
                ],
              },
            ],
          },
        },
      ],
    });

    const deleted = await applyBlockEdit(deps, actor, {
      pageId: page.id,
      basePageVersion: created.pageVersion,
      ops: [{ op: 'delete', blockId: sectionId, baseVersion: 1 }],
    });

    const rows = await handle.sql<
      {
        blockType: string;
        props: unknown;
        layout: unknown;
        parentBlockId: string | null;
      }[]
    >`
      SELECT block_type AS "blockType", props, layout,
        parent_block_id AS "parentBlockId"
      FROM block_revisions
      WHERE revision_batch_id = ${deleted.revisionBatchId}
        AND change_type = 'delete'
      ORDER BY depth
    `;
    expect(rows.map((row) => row.blockType)).toEqual([
      'section',
      'column',
      'text',
    ]);
    expect(rows[0]?.layout).toEqual({ columns: '2:1', align: 'center' });
    expect(rows[2]?.props).toEqual({ value: 'Keep me' });
    expect(rows[2]?.parentBlockId).toBe(columnId);
    expect(await blockCount(page.id)).toBe(0);

    // The deleted ids are free again, so an undo can put the subtree back
    // under its original ids.
    const restored = await applyBlockEdit(deps, actor, {
      pageId: page.id,
      basePageVersion: deleted.pageVersion,
      ops: [
        {
          op: 'insert',
          position: { parentId: null },
          node: {
            id: sectionId,
            type: 'section',
            layout: { columns: '2:1', align: 'center' },
            children: [
              {
                id: columnId,
                type: 'column',
                children: [
                  { id: textId, type: 'text', props: { value: 'Keep me' } },
                ],
              },
            ],
          },
        },
      ],
    });
    expect(restored.createdIds).toEqual([sectionId, columnId, textId]);
  });

  it('never writes a publication, changes the live publication or purges a cache (EDIT-12, D-25)', async () => {
    const f = await buildMoveDeleteFixture('Batch never publishes');
    await publishPage(deps, actor, {
      pageId: f.page.id,
      baseVersion: f.page.version,
    });
    const published = await currentPage(f.page.id);
    expect(published.livePublicationId).not.toBeNull();
    const publicationCount = async (): Promise<number> => {
      const [row] = await handle.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM page_publications
        WHERE page_id = ${f.page.id}
      `;
      return Number(row?.count ?? '0');
    };
    const publicationsBefore = await publicationCount();

    const purges: string[][] = [];
    const spy: CacheInvalidator = {
      purge(tags) {
        purges.push([...tags]);
        return Promise.resolve();
      },
    };
    await applyBlockEdit({ ...deps, invalidator: spy }, actor, {
      pageId: f.page.id,
      basePageVersion: published.version,
      ops: [
        {
          op: 'update',
          blockId: f.text.id,
          baseVersion: f.text.version,
          props: { value: 'Draft only' },
        },
        {
          op: 'delete',
          blockId: f.doomed.id,
          baseVersion: f.doomed.version,
        },
      ],
    });

    expect(await publicationCount()).toBe(publicationsBefore);
    expect((await currentPage(f.page.id)).livePublicationId).toBe(
      published.livePublicationId,
    );
    expect(purges).toEqual([]);
  });
});
