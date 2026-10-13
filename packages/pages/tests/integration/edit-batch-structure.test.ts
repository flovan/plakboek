/**
 * The structural side of `applyBlockEdit` (D-03, D-20, D-22), proven against
 * real Postgres: a new section starts with a column, a block's declared
 * starter children come with it, a duplicate copies a whole subtree, and no
 * batch can leave a section without a column.
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
  SectionColumnRequiredError,
} from '../../src/edit-batch.js';
import { createPage, getPage, StalePageVersionError } from '../../src/pages.js';
import { defineBlocks } from '../../src/registry.js';
import { insertBlock, readBlockTree } from '../../src/tree.js';
import type { BlockRecord, OwnerRef, PageRecord } from '../../src/types.js';
import { createTestDatabase } from './test-database.js';

describe('structural batch edits (D-03, D-20, D-22)', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let db: AuditDatabase;
  let deps: PagesDeps;
  let actor: AuditActor;
  const clock = (): Date => new Date('2026-10-13T15:00:00.000Z');

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
              options: { maxLength: 80 },
            },
          },
        },
        {
          key: 'note',
          editor: { label: 'Note' },
          schemaVersion: 2,
          upcasters: { 2: (props) => props },
          properties: {
            value: {
              fieldType: 'short_text',
              label: 'Value',
              options: { maxLength: 80 },
            },
          },
        },
        {
          key: 'slide',
          editor: { label: 'Slide' },
          schemaVersion: 1,
          properties: {},
        },
        {
          key: 'carousel',
          editor: { label: 'Carousel' },
          schemaVersion: 1,
          properties: {},
          placement: { allowedChildren: ['slide'] },
          starterChildren: [{ type: 'slide' }, { type: 'slide' }],
        },
      ]),
      sectionNestingDepth: 2,
      blockDepthCeiling: 12,
    });

    const user = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'edit-batch-structure@example.com',
      name: 'Structure',
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

  /** A page with one section, one column and two texts. */
  async function buildFixture(title: string) {
    const page = await createPage(deps, actor, { locale: 'en', title });
    const section = await add(page, 'section', null);
    const column = await add(page, 'column', section.id);
    const first = await add(page, 'text', column.id, { value: 'One' });
    const second = await add(page, 'text', column.id, { value: 'Two' });
    return {
      page: await currentPage(page.id),
      section,
      column,
      first,
      second,
    };
  }

  async function blockCount(pageId: string): Promise<number> {
    const [row] = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM page_blocks WHERE owner_id = ${pageId}
    `;
    return Number(row?.count ?? '0');
  }

  async function sectionsWithoutColumn(pageId: string): Promise<number> {
    const [row] = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM page_blocks s
      WHERE s.owner_id = ${pageId} AND s.block_type = 'section'
        AND NOT EXISTS (
          SELECT 1 FROM page_blocks c
          WHERE c.parent_block_id = s.id AND c.block_type = 'column'
        )
    `;
    return Number(row?.count ?? '0');
  }

  async function columnCount(sectionId: string): Promise<number> {
    const [row] = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM page_blocks
      WHERE parent_block_id = ${sectionId} AND block_type = 'column'
    `;
    return Number(row?.count ?? '0');
  }

  it('gives a bare inserted section one column', async () => {
    const { page } = await buildFixture('Starter section');

    const result = await applyBlockEdit(deps, actor, {
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

    expect(result.createdIds).toHaveLength(2);
    const tree = await readBlockTree(db, ownerOf(page));
    const inserted = tree.find((node) => node.id === result.createdIds[0]);
    expect(inserted?.children.map((child) => child.blockType)).toEqual([
      'column',
    ]);
    expect(inserted?.children[0]?.id).toBe(result.createdIds[1]);
  });

  it('gives a block its declared starter children', async () => {
    const { page, column } = await buildFixture('Starter children');

    const result = await applyBlockEdit(deps, actor, {
      pageId: page.id,
      basePageVersion: page.version,
      ops: [
        {
          op: 'insert',
          position: { parentId: column.id },
          node: { type: 'carousel' },
        },
      ],
    });

    expect(result.createdIds).toHaveLength(3);
    const tree = await readBlockTree(db, ownerOf(page));
    const carousel = tree[0]?.children[0]?.children.find(
      (node) => node.id === result.createdIds[0],
    );
    expect(carousel?.children.map((child) => child.blockType)).toEqual([
      'slide',
      'slide',
    ]);
  });

  it('takes sent children as they are, adding no starter content', async () => {
    const { page, column } = await buildFixture('Explicit children');

    const result = await applyBlockEdit(deps, actor, {
      pageId: page.id,
      basePageVersion: page.version,
      ops: [
        {
          op: 'insert',
          position: { parentId: column.id },
          node: {
            type: 'carousel',
            children: [{ type: 'slide' }],
          },
        },
      ],
    });

    expect(result.createdIds).toHaveLength(2);
  });

  it('duplicates a section with its whole subtree right after the original', async () => {
    const { page, section, column, first, second } =
      await buildFixture('Duplicate section');
    const other = await add(page, 'section', null);
    await add(page, 'column', other.id);
    const fresh = await currentPage(page.id);
    const blocksBefore = await blockCount(page.id);

    const result = await applyBlockEdit(deps, actor, {
      pageId: page.id,
      basePageVersion: fresh.version,
      ops: [{ op: 'duplicate', blockId: section.id }],
    });

    expect(result.createdIds).toHaveLength(4);
    expect(await blockCount(page.id)).toBe(blocksBefore + 4);
    const tree = await readBlockTree(db, ownerOf(page));
    expect(tree.map((node) => node.id)).toEqual([
      section.id,
      result.createdIds[0],
      other.id,
    ]);
    const copy = tree[1];
    expect(copy?.blockType).toBe('section');
    expect(copy?.children).toHaveLength(1);
    const copyColumn = copy?.children[0];
    expect(copyColumn?.id).toBe(result.createdIds[1]);
    expect(copyColumn?.children.map((node) => node.id)).toEqual([
      result.createdIds[2],
      result.createdIds[3],
    ]);
    expect(copyColumn?.children.map((node) => node.props)).toEqual([
      { value: 'One' },
      { value: 'Two' },
    ]);
    const originalIds = new Set([section.id, column.id, first.id, second.id]);
    expect(result.createdIds.some((id) => originalIds.has(id))).toBe(false);
    expect(result.touchedParentIds).toEqual([null]);

    const revisions = await handle.sql<{ changeType: string }[]>`
      SELECT change_type AS "changeType" FROM block_revisions
      WHERE revision_batch_id = ${result.revisionBatchId}
    `;
    expect(revisions).toHaveLength(4);
    expect(revisions.every((row) => row.changeType === 'create')).toBe(true);
  });

  it('keeps layout, props and schema versions of every copied block', async () => {
    const { page, section, column } = await buildFixture('Duplicate verbatim');
    const note = await add(page, 'note', column.id, { value: 'Old note' });
    // An older stored shape: a schema version behind the registry's and a
    // property the current declaration no longer knows.
    await handle.sql`
      UPDATE page_blocks
      SET schema_version = 1, props = ${JSON.stringify({ value: 'Old note', legacy: 'kept' })}::jsonb
      WHERE id = ${note.id}
    `;
    await handle.sql`
      UPDATE page_blocks
      SET layout = ${JSON.stringify({ align: 'center' })}::jsonb
      WHERE id = ${section.id}
    `;
    const fresh = await currentPage(page.id);

    const result = await applyBlockEdit(deps, actor, {
      pageId: page.id,
      basePageVersion: fresh.version,
      ops: [{ op: 'duplicate', blockId: section.id }],
    });

    const [copiedSection] = await handle.sql<
      { layout: unknown; schemaVersion: number }[]
    >`
      SELECT layout, schema_version AS "schemaVersion" FROM page_blocks
      WHERE id = ${result.createdIds[0] ?? ''}
    `;
    expect(copiedSection?.layout).toEqual({ align: 'center' });
    const rows = await handle.sql<
      { blockType: string; props: unknown; schemaVersion: number }[]
    >`
      SELECT block_type AS "blockType", props, schema_version AS "schemaVersion"
      FROM page_blocks WHERE id = ANY(${result.createdIds})
    `;
    const copiedNote = rows.find((row) => row.blockType === 'note');
    expect(copiedNote?.schemaVersion).toBe(1);
    expect(copiedNote?.props).toEqual({ value: 'Old note', legacy: 'kept' });
  });

  it('lets the copy of the root take a client id', async () => {
    const { page, first, second } = await buildFixture('Duplicate client id');
    const newId = randomUUID();

    const result = await applyBlockEdit(deps, actor, {
      pageId: page.id,
      basePageVersion: page.version,
      ops: [{ op: 'duplicate', blockId: first.id, newId }],
    });

    expect(result.createdIds).toEqual([newId]);
    const tree = await readBlockTree(db, ownerOf(page));
    expect(tree[0]?.children[0]?.children.map((node) => node.id)).toEqual([
      first.id,
      newId,
      second.id,
    ]);
  });

  it('refuses to delete the last column of a section, changing nothing', async () => {
    const { page, section, column } = await buildFixture('Last column');
    const blocksBefore = await blockCount(page.id);

    const error: unknown = await applyBlockEdit(deps, actor, {
      pageId: page.id,
      basePageVersion: page.version,
      ops: [{ op: 'delete', blockId: column.id, baseVersion: column.version }],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SectionColumnRequiredError);
    expect(error).toMatchObject({ sectionId: section.id });
    expect(await blockCount(page.id)).toBe(blocksBefore);
    expect((await currentPage(page.id)).version).toBe(page.version);
  });

  it('refuses to move the last column out of its section', async () => {
    const { page, column } = await buildFixture('Move last column');
    const target = await add(page, 'section', null);
    await add(page, 'column', target.id);
    const fresh = await currentPage(page.id);

    const error: unknown = await applyBlockEdit(deps, actor, {
      pageId: page.id,
      basePageVersion: fresh.version,
      ops: [
        {
          op: 'move',
          blockId: column.id,
          baseVersion: column.version,
          position: { parentId: target.id },
        },
      ],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SectionColumnRequiredError);
    expect(await sectionsWithoutColumn(page.id)).toBe(0);
  });

  it('allows deleting a column when the section keeps another one', async () => {
    const { page, section, column } = await buildFixture('Two columns');
    const added = await applyBlockEdit(deps, actor, {
      pageId: page.id,
      basePageVersion: page.version,
      ops: [
        {
          op: 'insert',
          position: { parentId: section.id },
          node: { type: 'column' },
        },
      ],
    });

    await applyBlockEdit(deps, actor, {
      pageId: page.id,
      basePageVersion: added.pageVersion,
      ops: [{ op: 'delete', blockId: column.id, baseVersion: column.version }],
    });

    expect(await columnCount(section.id)).toBe(1);
  });

  it('adds a column and resets the layout in one batch, and a re-sent batch adds no second column (EDIT-11 idempotency)', async () => {
    const { page, section } = await buildFixture('Add column idempotency');
    const batch = {
      pageId: page.id,
      basePageVersion: page.version,
      ops: [
        {
          op: 'insert' as const,
          position: { parentId: section.id },
          node: { type: 'column' },
        },
        {
          op: 'update' as const,
          blockId: section.id,
          baseVersion: section.version,
          layout: { columns: '1:1' },
        },
      ],
    };

    await applyBlockEdit(deps, actor, batch);
    expect(await columnCount(section.id)).toBe(2);

    const error: unknown = await applyBlockEdit(deps, actor, batch).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(StalePageVersionError);
    expect(await columnCount(section.id)).toBe(2);
  });

  it('never leaves a section without a column when deleting its last column races a move into it (EDIT-11 concurrency)', async () => {
    const { page, column } = await buildFixture('Last column race');
    const spare = await add(page, 'section', null);
    const spareColumn = await add(page, 'column', spare.id);
    const mover = await add(page, 'text', spareColumn.id, { value: 'Mover' });
    const fresh = await currentPage(page.id);

    const results = await Promise.allSettled([
      applyBlockEdit(deps, actor, {
        pageId: page.id,
        basePageVersion: fresh.version,
        ops: [
          { op: 'delete', blockId: column.id, baseVersion: column.version },
        ],
      }),
      applyBlockEdit(deps, actor, {
        pageId: page.id,
        basePageVersion: fresh.version,
        ops: [
          {
            op: 'move',
            blockId: mover.id,
            baseVersion: mover.version,
            position: { parentId: column.id },
          },
        ],
      }),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled').length,
    ).toBeLessThanOrEqual(1);
    expect(await sectionsWithoutColumn(page.id)).toBe(0);
  });
});
