/**
 * Block layout (D-33, D-04, D-05, D-08) end to end against real Postgres: a
 * section's column ratio is validated, written, read back, recorded in its
 * revision and carried into the published snapshot; anything unknown is
 * refused naming the key and code only.
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
import { BlockLayoutValidationError } from '../../src/layout.js';
import { createPage, getPage } from '../../src/pages.js';
import { publishPage } from '../../src/publish.js';
import { defineBlocks } from '../../src/registry.js';
import { restoreRevisionBatch } from '../../src/revisions.js';
import {
  insertBlock,
  readBlockTree,
  updateBlockProps,
} from '../../src/tree.js';
import type { BlockRecord, OwnerRef, PageRecord } from '../../src/types.js';
import { createTestDatabase } from './test-database.js';

const blocks = defineBlocks([
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
    key: 'quote',
    editor: { label: 'Quote' },
    schemaVersion: 1,
    properties: {},
    layout: { fill: true },
  },
  {
    key: 'text',
    editor: { label: 'Text' },
    schemaVersion: 1,
    properties: {},
  },
]);

describe('block layout through the write, read, revision and publish paths', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let db: AuditDatabase;
  let deps: PagesDeps;
  let actor: AuditActor;
  const clock = (): Date => new Date('2026-10-13T12:00:00.000Z');

  function pagesConfig(columnPresets?: { add?: string[]; exclude?: string[] }) {
    return definePagesConfig({
      content: defineContentConfig({
        locales: ['en'],
        defaultLocale: 'en',
        timezone: 'UTC',
      }),
      blocks,
      sectionNestingDepth: 2,
      blockDepthCeiling: 12,
      ...(columnPresets === undefined ? {} : { columnPresets }),
    });
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
      email: 'layout@example.com',
      name: 'Layout',
      roleKey: SUPERADMIN_ROLE_KEY,
    });
    actor = { userId: user.userId, roleKey: user.roleKey };
    deps = { db, recorder, resolver, config: pagesConfig(), now: clock };
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
    layout?: unknown,
    withDeps: PagesDeps = deps,
  ): Promise<BlockRecord> {
    const current = await getPage(db, page.id);
    if (current === null) throw new Error('page vanished mid-test');
    return await insertBlock(withDeps, actor, {
      owner: ownerOf(page),
      blockType,
      parentBlockId,
      basePageVersion: current.version,
      ...(layout === undefined ? {} : { layout }),
    });
  }

  async function refusal(promise: Promise<unknown>): Promise<unknown> {
    return await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
  }

  it('writes a section layout, reads it back, records it in the create revision and publishes it', async () => {
    const page = await freshPage('Layout round trip');
    const section = await add(page, 'section', null, {
      columns: '2:1',
      align: 'center',
    });
    expect(section.layout).toEqual({ columns: '2:1', align: 'center' });

    const column = await add(page, 'column', section.id);
    const text = await add(page, 'text', column.id);

    const tree = await readBlockTree(db, ownerOf(page));
    expect(tree[0]?.layout).toEqual({ columns: '2:1', align: 'center' });
    expect(tree[0]?.children[0]?.layout).toBeNull();

    const revisions = await handle.sql<{ layout: unknown }[]>`
      SELECT layout FROM block_revisions
      WHERE block_id = ${section.id} AND change_type = 'create'
    `;
    expect(revisions[0]?.layout).toEqual({ columns: '2:1', align: 'center' });

    const current = await getPage(db, page.id);
    const publication = await publishPage(deps, actor, {
      pageId: page.id,
      baseVersion: current?.version ?? 0,
    });
    const [snapshotSection] = publication.snapshot.blocks;
    expect(snapshotSection?.layout).toEqual({
      columns: '2:1',
      align: 'center',
    });
    const snapshotText = snapshotSection?.children[0]?.children[0];
    expect(snapshotText?.id).toBe(text.id);
    expect(snapshotText !== undefined && 'layout' in snapshotText).toBe(false);
  });

  it('stores an equal ratio and stretch alignment as no layout at all', async () => {
    const page = await freshPage('Layout normalising');
    const equalRatio = await add(page, 'section', null, { columns: '1:1' });
    const stretch = await add(page, 'section', null, { align: 'stretch' });
    expect(equalRatio.layout).toBeNull();
    expect(stretch.layout).toBeNull();
    const rows = await handle.sql<{ layout: unknown }[]>`
      SELECT layout FROM page_blocks WHERE id IN (${equalRatio.id}, ${stretch.id})
    `;
    expect(rows.every((row) => row.layout === null)).toBe(true);
  });

  it('refuses an unknown preset, an unsupported fill, a column layout and an unknown key, naming key and code only', async () => {
    const page = await freshPage('Layout refusals');
    const section = await add(page, 'section', null);
    const column = await add(page, 'column', section.id);

    const cases: [string, string | null, unknown, string, string][] = [
      ['section', null, { columns: '9:1' }, 'columns', 'INVALID'],
      ['text', column.id, { fill: true }, 'fill', 'UNKNOWN'],
      ['column', section.id, { columns: '2:1' }, 'columns', 'UNKNOWN'],
      ['section', null, { x: 1 }, 'x', 'UNKNOWN'],
    ];
    for (const [blockType, parent, layout, key, code] of cases) {
      const error = await refusal(add(page, blockType, parent, layout));
      expect(error).toBeInstanceOf(BlockLayoutValidationError);
      if (!(error instanceof BlockLayoutValidationError)) continue;
      expect(error.issues).toEqual([{ key, code }]);
      expect(error.message).not.toContain('9:1');
    }

    const quote = await add(page, 'quote', column.id, { fill: true });
    expect(quote.layout).toEqual({ fill: true });
  });

  it('clears layout with null on update and keeps it when omitted', async () => {
    const page = await freshPage('Layout update');
    const section = await add(page, 'section', null, { columns: '1:2' });

    const kept = await updateBlockProps(deps, actor, {
      blockId: section.id,
      baseVersion: section.version,
      props: {},
    });
    expect(kept.layout).toEqual({ columns: '1:2' });

    const cleared = await updateBlockProps(deps, actor, {
      blockId: section.id,
      baseVersion: kept.version,
      props: {},
      layout: null,
    });
    expect(cleared.layout).toBeNull();

    const updateRevision = await handle.sql<{ layout: unknown }[]>`
      SELECT layout FROM block_revisions
      WHERE block_id = ${section.id} AND change_type = 'update'
      ORDER BY created_at DESC, id LIMIT 2
    `;
    const stored = updateRevision.map((row) => row.layout);
    expect(stored).toHaveLength(2);
    expect(stored).toContainEqual({ columns: '1:2' });
    expect(stored).toContainEqual(null);
  });

  it('applies the configured presets to new writes only', async () => {
    const page = await freshPage('Layout presets');
    const withExtra = { ...deps, config: pagesConfig({ add: ['3:1'] }) };
    const added = await add(
      page,
      'section',
      null,
      { columns: '3:1' },
      withExtra,
    );
    expect(added.layout).toEqual({ columns: '3:1' });

    const withoutTwoOne = {
      ...deps,
      config: pagesConfig({ exclude: ['2:1'] }),
    };
    const error = await refusal(
      add(page, 'section', null, { columns: '2:1' }, withoutTwoOne),
    );
    expect(error).toBeInstanceOf(BlockLayoutValidationError);

    // The stored '3:1' still reads back after the host drops the preset.
    const tree = await readBlockTree(db, ownerOf(page));
    expect(tree.find((node) => node.id === added.id)?.layout).toEqual({
      columns: '3:1',
    });
  });

  describe('restoring an update revision', () => {
    async function layoutOf(blockId: string): Promise<unknown> {
      const [row] = await handle.sql<{ layout: unknown }[]>`
        SELECT layout FROM page_blocks WHERE id = ${blockId}
      `;
      return row?.layout;
    }

    async function layoutOnlyBatch(page: PageRecord) {
      const section = await add(page, 'section', null, { columns: '2:1' });
      const changed = await updateBlockProps(deps, actor, {
        blockId: section.id,
        baseVersion: section.version,
        props: {},
        layout: { columns: '1:2' },
      });
      const [batch] = await handle.sql<{ revisionBatchId: string }[]>`
        SELECT revision_batch_id AS "revisionBatchId" FROM block_revisions
        WHERE block_id = ${section.id} AND change_type = 'update'
      `;
      await updateBlockProps(deps, actor, {
        blockId: section.id,
        baseVersion: changed.version,
        props: {},
        layout: null,
      });
      expect(await layoutOf(section.id)).toBeNull();
      return { section, revisionBatchId: batch!.revisionBatchId };
    }

    it('writes the stored layout back and records it in the restore revision (CR-D-01)', async () => {
      const page = await freshPage('Layout restore');
      const { section, revisionBatchId } = await layoutOnlyBatch(page);

      const current = await getPage(db, page.id);
      const restored = await restoreRevisionBatch(deps, actor, {
        revisionBatchId,
        pageId: page.id,
        basePageVersion: current?.version ?? 0,
      });
      expect(restored.restoredBlocks).toBe(1);

      expect(await layoutOf(section.id)).toEqual({ columns: '1:2' });
      const [revision] = await handle.sql<{ layout: unknown }[]>`
        SELECT layout FROM block_revisions
        WHERE revision_batch_id = ${restored.revisionBatchId}
      `;
      expect(revision?.layout).toEqual({ columns: '1:2' });
    });

    it('leaves out a layout key the current configuration no longer accepts instead of failing the restore (CR-D-01)', async () => {
      const page = await freshPage('Layout restore stale preset');
      const { section, revisionBatchId } = await layoutOnlyBatch(page);

      const withoutPreset = {
        ...deps,
        config: pagesConfig({ exclude: ['1:2'] }),
      };
      const current = await getPage(db, page.id);
      const restored = await restoreRevisionBatch(withoutPreset, actor, {
        revisionBatchId,
        pageId: page.id,
        basePageVersion: current?.version ?? 0,
      });
      expect(restored.restoredBlocks).toBe(1);
      expect(await layoutOf(section.id)).toBeNull();
    });
  });
});
