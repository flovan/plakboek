/**
 * `assertPlacementAllowed` wired into `insertBlock` (BLOCK-05, D-08, D-18,
 * D-19), proven end to end against real Postgres: every `<behavior>` bullet
 * from 04-05-PLAN.md's Task 1, including the "nothing was written" proof
 * after a refusal (sibling count, the owning page's `version`, and
 * `audit_log`'s allowed-row count all unchanged).
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
import {
  BlockDepthExceededError,
  BlockPlacementError,
  SectionNestingDepthExceededError,
  SectionRequiredError,
} from '../../src/placement.js';
import { defineBlocks, UnknownBlockTypeError } from '../../src/registry.js';
import type { OwnerRef, PageRecord } from '../../src/types.js';
import { insertBlock } from '../../src/tree.js';
import { createTestDatabase } from './test-database.js';

const roles = defaultRoles;

describe('placement enforcement wired into insertBlock (BLOCK-05, D-08, D-18, D-19)', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let db: AuditDatabase;
  let deps: PagesDeps;
  let actor: AuditActor;
  const clock = (): Date => new Date('2026-09-25T11:00:00.000Z');

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
        {
          key: 'card',
          editor: { label: 'Card' },
          schemaVersion: 1,
          properties: {},
          placement: { allowedParents: ['section'] },
        },
        // `tile` carries no `allowedParents` restriction of its own (unlike
        // `card`) so it can independently exercise `grid`'s
        // `allowedChildren` restriction without `card`'s own
        // `allowedParents: ['section']` also refusing the same insert for a
        // different reason -- the two placement rules (child-side,
        // parent-side) are proven with two fixtures that each isolate one
        // side of the check.
        {
          key: 'tile',
          editor: { label: 'Tile' },
          schemaVersion: 1,
          properties: {},
        },
        {
          key: 'grid',
          editor: { label: 'Grid' },
          schemaVersion: 1,
          properties: {},
          placement: { allowedChildren: ['tile'] },
        },
        {
          key: 'restricted',
          editor: { label: 'Restricted' },
          schemaVersion: 1,
          properties: {},
          placement: { ownerTypes: [] },
        },
        // Self-nestable so it can build an arbitrarily long chain for the
        // block-depth-ceiling test below.
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

  async function siblingCount(
    parentBlockId: string | null,
    ownerId: string,
  ): Promise<number> {
    const rows =
      parentBlockId === null
        ? await handle.sql<{ count: string }[]>`
            SELECT count(*)::text AS count FROM page_blocks
            WHERE owner_id = ${ownerId} AND parent_block_id IS NULL
          `
        : await handle.sql<{ count: string }[]>`
            SELECT count(*)::text AS count FROM page_blocks
            WHERE parent_block_id = ${parentBlockId}
          `;
    return Number(rows[0]?.count ?? '0');
  }

  async function allowedInsertAuditCount(): Promise<number> {
    const [row] = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log
      WHERE action = 'block.insert' AND outcome = 'allowed'
    `;
    return Number(row?.count ?? '0');
  }

  it('refuses a heading with no parent under a page owner, naming heading; a section succeeds', async () => {
    const page = await freshPage('Refuse bare heading');
    const owner = ownerOf(page);

    const error: unknown = await insertBlock(deps, actor, {
      owner,
      blockType: 'heading',
      parentBlockId: null,
      basePageVersion: page.version,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SectionRequiredError);
    expect((error as SectionRequiredError).blockType).toBe('heading');

    const section = await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: null,
      basePageVersion: (await currentPage(page.id)).version,
    });
    expect(section.blockType).toBe('section');
  });

  it('allows a heading inside a section; refuses a section inside a heading (allowedChildren: none), naming parent and child', async () => {
    const page = await freshPage('Section then heading');
    const owner = ownerOf(page);
    const section = await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: null,
      basePageVersion: page.version,
    });

    const heading = await insertBlock(deps, actor, {
      owner,
      blockType: 'heading',
      parentBlockId: section.id,
      basePageVersion: (await currentPage(page.id)).version,
    });
    expect(heading.parentBlockId).toBe(section.id);

    const error: unknown = await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: heading.id,
      basePageVersion: (await currentPage(page.id)).version,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BlockPlacementError);
    const placementError = error as BlockPlacementError;
    expect(placementError.reason).toBe('parent-rejects-child');
    expect(placementError.parentKey).toBe('heading');
    expect(placementError.childKey).toBe('section');
  });

  it('refuses a card (allowedParents: [section]) under a grid; allows it under a section', async () => {
    const page = await freshPage('Card placement');
    const owner = ownerOf(page);
    const section = await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: null,
      basePageVersion: page.version,
    });
    const grid = await insertBlock(deps, actor, {
      owner,
      blockType: 'grid',
      parentBlockId: section.id,
      basePageVersion: (await currentPage(page.id)).version,
    });

    const error: unknown = await insertBlock(deps, actor, {
      owner,
      blockType: 'card',
      parentBlockId: grid.id,
      basePageVersion: (await currentPage(page.id)).version,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BlockPlacementError);

    const card = await insertBlock(deps, actor, {
      owner,
      blockType: 'card',
      parentBlockId: section.id,
      basePageVersion: (await currentPage(page.id)).version,
    });
    expect(card.parentBlockId).toBe(section.id);
  });

  it('a grid (allowedChildren: [tile]) accepts a tile and refuses a heading', async () => {
    const page = await freshPage('Grid children');
    const owner = ownerOf(page);
    const section = await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: null,
      basePageVersion: page.version,
    });
    const grid = await insertBlock(deps, actor, {
      owner,
      blockType: 'grid',
      parentBlockId: section.id,
      basePageVersion: (await currentPage(page.id)).version,
    });

    const tile = await insertBlock(deps, actor, {
      owner,
      blockType: 'tile',
      parentBlockId: grid.id,
      basePageVersion: (await currentPage(page.id)).version,
    });
    expect(tile.parentBlockId).toBe(grid.id);

    const error: unknown = await insertBlock(deps, actor, {
      owner,
      blockType: 'heading',
      parentBlockId: grid.id,
      basePageVersion: (await currentPage(page.id)).version,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BlockPlacementError);
  });

  it('refuses a block declaring ownerTypes: [] under every owner type', async () => {
    const page = await freshPage('Restricted owner type');
    const owner = ownerOf(page);
    const section = await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: null,
      basePageVersion: page.version,
    });

    const error: unknown = await insertBlock(deps, actor, {
      owner,
      blockType: 'restricted',
      parentBlockId: section.id,
      basePageVersion: (await currentPage(page.id)).version,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BlockPlacementError);
    expect((error as BlockPlacementError).reason).toBe('owner-type');
  });

  it('a section inside a section succeeds at sectionNestingDepth: 2; a third nested section refuses, carrying cap: 2 and attempted: 3', async () => {
    const page = await freshPage('Section nesting cap');
    const owner = ownerOf(page);
    const outer = await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: null,
      basePageVersion: page.version,
    });
    const inner = await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: outer.id,
      basePageVersion: (await currentPage(page.id)).version,
    });
    expect(inner.parentBlockId).toBe(outer.id);

    const error: unknown = await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: inner.id,
      basePageVersion: (await currentPage(page.id)).version,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SectionNestingDepthExceededError);
    const depthError = error as SectionNestingDepthExceededError;
    expect(depthError.cap).toBe(2);
    expect(depthError.attempted).toBe(3);
  });

  it('section depth counts sections only: a section nested inside a section that sits inside a non-section block still counts as section depth 2', async () => {
    const page = await freshPage('Section depth counts sections only');
    const owner = ownerOf(page);
    const outerSection = await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: null,
      basePageVersion: page.version,
    });
    const wrapper = await insertBlock(deps, actor, {
      owner,
      blockType: 'wrapper',
      parentBlockId: outerSection.id,
      basePageVersion: (await currentPage(page.id)).version,
    });

    // wrapper is not a section, so nesting a section under it is still only
    // section depth 2 (outerSection + this one) -- exactly as if it sat
    // directly under outerSection.
    const nestedSection = await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: wrapper.id,
      basePageVersion: (await currentPage(page.id)).version,
    });
    expect(nestedSection.parentBlockId).toBe(wrapper.id);

    // A further section here would be section depth 3, refused -- proving
    // wrapper's own non-section presence in the chain did not reset the
    // count back to 0.
    const error: unknown = await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: nestedSection.id,
      basePageVersion: (await currentPage(page.id)).version,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SectionNestingDepthExceededError);
    expect((error as SectionNestingDepthExceededError).attempted).toBe(3);
  });

  it('a chain of nested blocks reaching blockDepthCeiling inserts; the next one refuses, carrying ceiling and attempted', async () => {
    const page = await freshPage('Block depth ceiling');
    const owner = ownerOf(page);
    // blockDepthCeiling: 4 in this suite's config. section is depth 0; four
    // wrapper levels bring the chain to depth 4 (the ceiling); a fifth
    // must refuse.
    const section = await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: null,
      basePageVersion: page.version,
    });
    let parentId: string = section.id;
    let depth = 0;

    while (depth < 4) {
      const wrapper = await insertBlock(deps, actor, {
        owner,
        blockType: 'wrapper',
        parentBlockId: parentId,
        basePageVersion: (await currentPage(page.id)).version,
      });
      expect(wrapper.depth).toBe(depth + 1);
      parentId = wrapper.id;
      depth += 1;
    }

    const error: unknown = await insertBlock(deps, actor, {
      owner,
      blockType: 'wrapper',
      parentBlockId: parentId,
      basePageVersion: (await currentPage(page.id)).version,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BlockDepthExceededError);
    const depthError = error as BlockDepthExceededError;
    expect(depthError.ceiling).toBe(4);
    expect(depthError.attempted).toBe(5);
  });

  it('refuses an unregistered block type before any row is written', async () => {
    const page = await freshPage('Unknown block type');
    const owner = ownerOf(page);
    const before = await siblingCount(null, page.id);

    const error: unknown = await insertBlock(deps, actor, {
      owner,
      blockType: 'doesNotExist',
      parentBlockId: null,
      basePageVersion: page.version,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnknownBlockTypeError);
    expect(await siblingCount(null, page.id)).toBe(before);
  });

  it('every refusal writes nothing: sibling count, page version and the audit_log allowed-row count are unchanged', async () => {
    const page = await freshPage('Refusal writes nothing');
    const owner = ownerOf(page);
    const beforeSiblings = await siblingCount(null, page.id);
    const beforeVersion = (await currentPage(page.id)).version;
    const beforeAudit = await allowedInsertAuditCount();

    const error: unknown = await insertBlock(deps, actor, {
      owner,
      blockType: 'heading',
      parentBlockId: null,
      basePageVersion: beforeVersion,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SectionRequiredError);

    expect(await siblingCount(null, page.id)).toBe(beforeSiblings);
    expect((await currentPage(page.id)).version).toBe(beforeVersion);
    expect(await allowedInsertAuditCount()).toBe(beforeAudit);
  });
});
