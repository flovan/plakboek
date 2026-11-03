/**
 * Keep data, flag, never crash (TEXT-04) against real Postgres: a rich text
 * document the theme no longer allows never blocks an edit to another
 * property of its block, is never rewritten, and is still refused as soon as
 * it changes or the page is published.
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
import { defineContentConfig, registerTextTheme } from '@plakboek/content';
import {
  DEFAULT_TEXT_THEME,
  resolveTextTheme,
} from '@plakboek/content/rich-text';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import {
  createPermissionResolver,
  defaultRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definePagesConfig, type PagesDeps } from '../../src/config.js';
import { previewBlockValues } from '../../src/layout.js';
import { createPage, getPage } from '../../src/pages.js';
import { DegradedBlockPublishError, publishPage } from '../../src/publish.js';
import { BlockPropsValidationError, defineBlocks } from '../../src/registry.js';
import {
  insertBlock,
  readBlockTree,
  updateBlockProps,
} from '../../src/tree.js';
import type { BlockRecord, OwnerRef, PageRecord } from '../../src/types.js';
import { createTestDatabase } from './test-database.js';

function coloured(token: string): unknown {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Hello',
            marks: [{ type: 'textColor', attrs: { token, value: null } }],
          },
        ],
      },
    ],
  };
}

describe('an out-of-theme rich text document is kept and flagged (TEXT-04)', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let db: AuditDatabase;
  let deps: PagesDeps;
  let actor: AuditActor;
  const clock = (): Date => new Date('2026-10-19T13:00:00.000Z');

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
          key: 'prose',
          editor: { label: 'Prose' },
          schemaVersion: 1,
          properties: {
            body: { fieldType: 'rich_text', label: 'Body' },
            note: {
              fieldType: 'short_text',
              label: 'Note',
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
      email: 'keep-data@example.com',
      name: 'Keep data',
      roleKey: SUPERADMIN_ROLE_KEY,
    });
    actor = { userId: user.userId, roleKey: user.roleKey };
    deps = { db, recorder, resolver, config, now: clock };
  });

  afterAll(async () => {
    registerTextTheme(DEFAULT_TEXT_THEME);
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

  it('lets another property change, refuses a changed document and a publish, and never rewrites the stored one', async () => {
    registerTextTheme(
      resolveTextTheme({ colors: [{ label: 'Accent', token: 'accent' }] }),
    );
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Keep data',
    });
    const section = await add(page, 'section', null);
    const stored = coloured('accent');
    const prose = await add(page, 'prose', section.id, {
      body: stored,
      note: 'a',
    });
    expect(prose.props).toEqual({ body: stored, note: 'a' });

    // The installation drops its palette: the stored document is now outside
    // the theme.
    registerTextTheme(resolveTextTheme());

    const edited = await updateBlockProps(deps, actor, {
      blockId: prose.id,
      baseVersion: prose.version,
      props: { body: stored, note: 'b' },
    });
    expect(edited.props).toEqual({ body: stored, note: 'b' });

    const refusal = await updateBlockProps(deps, actor, {
      blockId: prose.id,
      baseVersion: edited.version,
      props: { body: coloured('brand'), note: 'b' },
    }).catch((caught: unknown) => caught);
    expect(refusal).toBeInstanceOf(BlockPropsValidationError);
    expect((refusal as BlockPropsValidationError).issues).toEqual([
      { propertyKey: 'body', code: 'INVALID' },
    ]);

    const publishRefusal = await publishPage(deps, actor, {
      pageId: page.id,
      baseVersion: (await getPage(db, page.id))?.version ?? 0,
    }).catch((caught: unknown) => caught);
    expect(publishRefusal).toBeInstanceOf(DegradedBlockPublishError);
    if (!(publishRefusal instanceof DegradedBlockPublishError)) return;
    expect(publishRefusal.blocks[0]).toMatchObject({
      blockId: prose.id,
      reason: 'invalid-props',
    });
    expect(publishRefusal.blocks[0]?.detail).toContain('"body": INVALID');

    // Neither refusal touched what was stored.
    const tree = await readBlockTree(db, ownerOf(page));
    const proseNode = tree.flatMap((node) => node.children).at(0);
    expect(proseNode?.props).toEqual({ body: stored, note: 'b' });
  });

  it('answers a live preview for an unchanged document and refuses a changed one', () => {
    const stored = coloured('accent');
    const unchanged = previewBlockValues(deps.config, {
      blockType: 'prose',
      props: { body: stored, note: 'x' },
      layout: null,
      storedProps: { body: stored, note: 'a' },
    });
    expect(unchanged.ok).toBe(true);

    const changed = previewBlockValues(deps.config, {
      blockType: 'prose',
      props: { body: coloured('brand'), note: 'x' },
      layout: null,
      storedProps: { body: stored, note: 'a' },
    });
    expect(changed).toEqual({
      ok: false,
      issues: [{ key: 'body', code: 'INVALID' }],
    });
  });
});
