/**
 * Working-tree leniency (D-21) against real Postgres: a block whose required
 * property is still empty can be inserted and updated, publishing that tree
 * is refused naming the key and REQUIRED, and anything else wrong with a
 * value is still refused on write.
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
import { DegradedBlockPublishError, publishPage } from '../../src/publish.js';
import { BlockPropsValidationError, defineBlocks } from '../../src/registry.js';
import { insertBlock, updateBlockProps } from '../../src/tree.js';
import type { BlockRecord, OwnerRef, PageRecord } from '../../src/types.js';
import { createTestDatabase } from './test-database.js';

describe('lenient required values on write, strict on publish (D-21)', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let db: AuditDatabase;
  let deps: PagesDeps;
  let actor: AuditActor;
  const clock = (): Date => new Date('2026-10-13T13:00:00.000Z');

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
            text: {
              fieldType: 'short_text',
              label: 'Text',
              required: true,
              options: { maxLength: 80 },
            },
          },
        },
      ]),
      sectionNestingDepth: 2,
      blockDepthCeiling: 12,
    });
    const user = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'lenient@example.com',
      name: 'Lenient',
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

  async function add(
    page: PageRecord,
    blockType: string,
    parentBlockId: string | null,
    props?: unknown,
  ): Promise<BlockRecord> {
    const current = await getPage(db, page.id);
    if (current === null) throw new Error('page vanished mid-test');
    return await insertBlock(deps, actor, {
      owner: ownerOf(page),
      blockType,
      parentBlockId,
      basePageVersion: current.version,
      ...(props === undefined ? {} : { props }),
    });
  }

  async function publish(page: PageRecord): Promise<unknown> {
    const current = await getPage(db, page.id);
    return await publishPage(deps, actor, {
      pageId: page.id,
      baseVersion: current?.version ?? 0,
    });
  }

  it('inserts and updates a block with an empty required value, refuses to publish it, then publishes once filled', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Lenient',
    });
    const section = await add(page, 'section', null);
    const text = await add(page, 'text', section.id);
    expect(text.props).toEqual({});

    const updated = await updateBlockProps(deps, actor, {
      blockId: text.id,
      baseVersion: text.version,
      props: {},
    });
    expect(updated.version).toBe(text.version + 1);

    const refusal = await publish(page).catch((caught: unknown) => caught);
    expect(refusal).toBeInstanceOf(DegradedBlockPublishError);
    if (!(refusal instanceof DegradedBlockPublishError)) return;
    expect(refusal.blocks).toHaveLength(1);
    expect(refusal.blocks[0]).toMatchObject({
      blockId: text.id,
      reason: 'invalid-props',
    });
    expect(refusal.blocks[0]?.detail).toContain('"text": REQUIRED');

    await updateBlockProps(deps, actor, {
      blockId: text.id,
      baseVersion: updated.version,
      props: { text: 'Hello' },
    });
    const publication = await publish(page);
    expect(publication).toMatchObject({ isDraft: false });
  });

  it('still refuses a value of the wrong type on insert', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Lenient wrong type',
    });
    const section = await add(page, 'section', null);
    const error = await add(page, 'text', section.id, { text: 12 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(BlockPropsValidationError);
    expect((error as BlockPropsValidationError).issues).toEqual([
      { propertyKey: 'text', code: 'INVALID' },
    ]);
  });
});
