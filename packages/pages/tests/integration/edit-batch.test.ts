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
import {
  applyBlockEdit,
  BlockOwnershipError,
  type BlockEditOp,
} from '../../src/edit-batch.js';
import { createPage, getPage, StalePageVersionError } from '../../src/pages.js';
import { defineBlocks } from '../../src/registry.js';
import { insertBlock, readBlockTree } from '../../src/tree.js';
import type { BlockRecord, OwnerRef, PageRecord } from '../../src/types.js';
import { createTestDatabase } from './test-database.js';

describe('applyBlockEdit (D-25)', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let db: AuditDatabase;
  let deps: PagesDeps;
  let actor: AuditActor;
  const clock = (): Date => new Date('2026-10-13T14:00:00.000Z');

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });
    db = handle.db;

    const resolver: PermissionResolver = createPermissionResolver(defaultRoles);
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
});
