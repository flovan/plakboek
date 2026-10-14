/**
 * The column block kind wired into insertBlock (D-01, D-02, D-03, D-15,
 * D-18), proven end to end against real Postgres: a section holds only
 * columns, a block under a column is judged against the column's section,
 * and a column never counts toward the section nesting cap.
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
import { restoreRevisionBatch } from '../../src/revisions.js';
import { SectionColumnRequiredError } from '../../src/section-columns.js';
import {
  BlockPlacementError,
  SectionNestingDepthExceededError,
  SectionRequiredError,
} from '../../src/placement.js';
import { defineBlocks } from '../../src/registry.js';
import type { BlockRecord, OwnerRef, PageRecord } from '../../src/types.js';
import { deleteBlock, insertBlock, moveBlock } from '../../src/tree.js';
import { createTestDatabase } from './test-database.js';

describe('column placement through insertBlock (D-01, D-02, D-03, D-15, D-18)', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let db: AuditDatabase;
  let deps: PagesDeps;
  let actor: AuditActor;
  const clock = (): Date => new Date('2026-10-13T11:00:00.000Z');

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
          properties: {},
        },
        {
          key: 'quote',
          editor: { label: 'Quote' },
          schemaVersion: 1,
          properties: {},
          layout: { fill: true },
        },
        {
          key: 'card',
          editor: { label: 'Card' },
          schemaVersion: 1,
          properties: {},
          placement: { allowedParents: ['section'] },
        },
        {
          key: 'accordionList',
          editor: { label: 'Accordion list' },
          schemaVersion: 1,
          properties: {},
          placement: { allowedChildren: ['accordionItem'] },
        },
        {
          key: 'accordionItem',
          editor: { label: 'Accordion item' },
          schemaVersion: 1,
          properties: {},
          placement: { allowedParents: ['accordionList'] },
        },
      ]),
      sectionNestingDepth: 2,
      blockDepthCeiling: 12,
    });

    const user = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'columns@example.com',
      name: 'Columns',
      roleKey: SUPERADMIN_ROLE_KEY,
    });
    actor = { userId: user.userId, roleKey: user.roleKey };
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

  async function add(
    page: PageRecord,
    blockType: string,
    parentBlockId: string | null,
  ): Promise<BlockRecord> {
    const current = await getPage(db, page.id);
    if (current === null) throw new Error('page vanished mid-test');
    return await insertBlock(deps, actor, {
      owner: ownerOf(page),
      blockType,
      parentBlockId,
      basePageVersion: current.version,
    });
  }

  async function refusal(
    page: PageRecord,
    blockType: string,
    parentBlockId: string | null,
  ): Promise<unknown> {
    return await add(page, blockType, parentBlockId).catch(
      (caught: unknown) => caught,
    );
  }

  async function move(
    page: PageRecord,
    block: BlockRecord,
    newParentBlockId: string,
  ): Promise<BlockRecord> {
    const current = await getPage(db, page.id);
    if (current === null) throw new Error('page vanished mid-test');
    const [row] = await handle.sql<{ version: number }[]>`
      SELECT version FROM page_blocks WHERE id = ${block.id}
    `;
    return await moveBlock(deps, actor, {
      blockId: block.id,
      baseVersion: row?.version ?? block.version,
      pageId: page.id,
      basePageVersion: current.version,
      newParentBlockId,
    });
  }

  async function moveRefusal(
    page: PageRecord,
    block: BlockRecord,
    newParentBlockId: string,
  ): Promise<unknown> {
    return await move(page, block, newParentBlockId).catch(
      (caught: unknown) => caught,
    );
  }

  it('accepts a section, then a column under it, then a text under the column', async () => {
    const page = await freshPage('Column happy path');
    const section = await add(page, 'section', null);
    const column = await add(page, 'column', section.id);
    const text = await add(page, 'text', column.id);
    expect(column.depth).toBe(1);
    expect(text.parentBlockId).toBe(column.id);
    expect(text.depth).toBe(2);
  });

  it('refuses a bare block directly under a section', async () => {
    const page = await freshPage('Bare block under section');
    const section = await add(page, 'section', null);
    const error = await refusal(page, 'text', section.id);
    expect(error).toBeInstanceOf(BlockPlacementError);
    expect((error as BlockPlacementError).reason).toBe(
      'section-requires-columns',
    );
  });

  it('refuses a column at the page root and a column under a non-section', async () => {
    const page = await freshPage('Misplaced columns');
    const rootError = await refusal(page, 'column', null);
    expect(rootError).toBeInstanceOf(SectionRequiredError);

    const section = await add(page, 'section', null);
    const column = await add(page, 'column', section.id);
    const text = await add(page, 'text', column.id);

    const underBlock = await refusal(page, 'column', text.id);
    expect(underBlock).toBeInstanceOf(BlockPlacementError);
    expect((underBlock as BlockPlacementError).reason).toBe(
      'column-requires-section',
    );

    const underColumn = await refusal(page, 'column', column.id);
    expect(underColumn).toBeInstanceOf(BlockPlacementError);
    expect((underColumn as BlockPlacementError).reason).toBe(
      'column-requires-section',
    );
  });

  it('judges a block under a column against the column section: allowedParents naming the section is accepted', async () => {
    const page = await freshPage('Card under a column');
    const section = await add(page, 'section', null);
    const column = await add(page, 'column', section.id);
    const card = await add(page, 'card', column.id);
    expect(card.parentBlockId).toBe(column.id);

    const error = await refusal(page, 'accordionItem', column.id);
    expect(error).toBeInstanceOf(BlockPlacementError);
    expect((error as BlockPlacementError).reason).toBe('child-rejects-parent');
    expect((error as BlockPlacementError).parentKey).toBe('section');
  });

  it('accepts an accordion item under an accordion list inside a column (D-15)', async () => {
    const page = await freshPage('Accordion in a column');
    const section = await add(page, 'section', null);
    const column = await add(page, 'column', section.id);
    const list = await add(page, 'accordionList', column.id);
    const item = await add(page, 'accordionItem', list.id);
    expect(item.parentBlockId).toBe(list.id);
  });

  it('counts a section nested in a column as section depth 2 and refuses a third level', async () => {
    const page = await freshPage('Section nesting through columns');
    const outer = await add(page, 'section', null);
    const outerColumn = await add(page, 'column', outer.id);
    const inner = await add(page, 'section', outerColumn.id);
    const innerColumn = await add(page, 'column', inner.id);

    const error = await refusal(page, 'section', innerColumn.id);
    expect(error).toBeInstanceOf(SectionNestingDepthExceededError);
    expect((error as SectionNestingDepthExceededError).attempted).toBe(3);
  });

  it('moves a text between columns of different sections', async () => {
    const page = await freshPage('Move between columns');
    const first = await add(page, 'section', null);
    const firstColumn = await add(page, 'column', first.id);
    const second = await add(page, 'section', null);
    const secondColumn = await add(page, 'column', second.id);
    const text = await add(page, 'text', firstColumn.id);

    const moved = await move(page, text, secondColumn.id);
    expect(moved.parentBlockId).toBe(secondColumn.id);
    expect(moved.depth).toBe(2);
  });

  it('refuses moving a text directly under a section', async () => {
    const page = await freshPage('Move bare block under section');
    const section = await add(page, 'section', null);
    const column = await add(page, 'column', section.id);
    const text = await add(page, 'text', column.id);

    const error = await moveRefusal(page, text, section.id);
    expect(error).toBeInstanceOf(BlockPlacementError);
    expect((error as BlockPlacementError).reason).toBe(
      'section-requires-columns',
    );
  });

  it('moves a column into another section and rewrites its own and its descendants depths', async () => {
    const page = await freshPage('Move a column');
    const outer = await add(page, 'section', null);
    const outerColumn = await add(page, 'column', outer.id);
    const target = await add(page, 'section', outerColumn.id);
    const source = await add(page, 'section', null);
    const sourceColumn = await add(page, 'column', source.id);
    await add(page, 'column', source.id);
    const text = await add(page, 'text', sourceColumn.id);

    const moved = await move(page, sourceColumn, target.id);
    expect(moved.parentBlockId).toBe(target.id);
    expect(moved.depth).toBe(3);

    const [textRow] = await handle.sql<{ depth: number }[]>`
      SELECT depth FROM page_blocks WHERE id = ${text.id}
    `;
    expect(textRow?.depth).toBe(4);
  });
  describe('a section keeps a column through the single-operation writers and the history restore (code review WR-D-01)', () => {
    async function versionOf(blockId: string): Promise<number> {
      const [row] = await handle.sql<{ version: number }[]>`
        SELECT version FROM page_blocks WHERE id = ${blockId}
      `;
      return row?.version ?? 0;
    }

    async function exists(blockId: string): Promise<boolean> {
      const rows = await handle.sql`
        SELECT 1 FROM page_blocks WHERE id = ${blockId}
      `;
      return rows.length > 0;
    }

    async function pageVersion(page: PageRecord): Promise<number> {
      return (await getPage(db, page.id))?.version ?? 0;
    }

    async function remove(page: PageRecord, block: BlockRecord) {
      return await deleteBlock(deps, actor, {
        blockId: block.id,
        baseVersion: await versionOf(block.id),
        pageId: page.id,
        basePageVersion: await pageVersion(page),
      });
    }

    it("refuses to delete a section's last column, and deletes one of two", async () => {
      const page = await freshPage('Delete the last column');
      const section = await add(page, 'section', null);
      const first = await add(page, 'column', section.id);
      const second = await add(page, 'column', section.id);

      await remove(page, second);
      expect(await exists(second.id)).toBe(false);

      const before = await pageVersion(page);
      const error: unknown = await remove(page, first).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(SectionColumnRequiredError);
      expect((error as SectionColumnRequiredError).sectionId).toBe(section.id);
      expect(await exists(first.id)).toBe(true);
      expect(await pageVersion(page)).toBe(before);
    });

    it("refuses to move a section's last column away, writing nothing", async () => {
      const page = await freshPage('Move the last column');
      const source = await add(page, 'section', null);
      const column = await add(page, 'column', source.id);
      const target = await add(page, 'section', null);
      await add(page, 'column', target.id);

      const before = await pageVersion(page);
      const error: unknown = await move(page, column, target.id).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(SectionColumnRequiredError);
      expect(await versionOf(column.id)).toBe(column.version);
      expect(await pageVersion(page)).toBe(before);
    });

    it('refuses to restore a move that takes the last column out of the section it is in now', async () => {
      const page = await freshPage('Restore a column move');
      const home = await add(page, 'section', null);
      const homeColumn = await add(page, 'column', home.id);
      const wanderer = await add(page, 'column', home.id);
      const away = await add(page, 'section', null);

      // The wanderer leaves `home` for `away`; the batch records where it was.
      await move(page, wanderer, away.id);
      const [batch] = await handle.sql<{ revisionBatchId: string }[]>`
        SELECT revision_batch_id AS "revisionBatchId" FROM block_revisions
        WHERE block_id = ${wanderer.id} AND change_type = 'move'
      `;
      expect(homeColumn.id).not.toBe(wanderer.id);

      // `away` now holds the wanderer as its only column; restoring the move
      // sends it home and would leave `away` with none.
      const before = await pageVersion(page);
      const error: unknown = await restoreRevisionBatch(deps, actor, {
        revisionBatchId: batch!.revisionBatchId,
        pageId: page.id,
        basePageVersion: before,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SectionColumnRequiredError);
      expect((error as SectionColumnRequiredError).sectionId).toBe(away.id);
      expect(await pageVersion(page)).toBe(before);
    });
  });
});
