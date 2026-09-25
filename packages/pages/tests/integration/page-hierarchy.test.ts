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
  defineRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definePagesConfig, type PagesDeps } from '../../src/config.js';
import { PageSlugConflictError } from '../../src/page-slug.js';
import {
  CircularPageMoveError,
  createPage,
  getPage,
  getPageByPath,
  listChildPages,
  movePage,
  PagePathConflictError,
  renamePage,
  StalePageVersionError,
} from '../../src/pages.js';
import { defineBlocks } from '../../src/registry.js';
import type { PageRecord } from '../../src/types.js';
import { createTestDatabase } from './test-database.js';

const roles = defineRoles(defaultRoles);

describe('page hierarchy: paths, re-parenting, URL history, slugs (D-21, D-23)', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let db: AuditDatabase;
  let deps: PagesDeps;
  let actor: AuditActor;
  const clock = (): Date => new Date('2026-09-25T10:00:00.000Z');

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });
    db = handle.db;

    const resolver: PermissionResolver = createPermissionResolver(roles);
    const recorder: AuditRecorder = createAuditRecorder({ db, resolver });
    const config = definePagesConfig({
      content: defineContentConfig({
        locales: ['en', 'nl'],
        defaultLocale: 'en',
        timezone: 'UTC',
      }),
      blocks: defineBlocks([
        { key: 'hero', label: 'Hero', schemaVersion: 1, properties: {} },
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

  async function historyRows(
    pageId: string,
  ): Promise<{ oldPath: string; reason: string }[]> {
    return await handle.sql<{ oldPath: string; reason: string }[]>`
      SELECT old_path AS "oldPath", reason
      FROM page_url_history
      WHERE page_id = ${pageId}
      ORDER BY id
    `;
  }

  async function historyRowCount(): Promise<number> {
    const [row] = await handle.sql<{ count: string }[]>`
      SELECT count(*) AS count FROM page_url_history
    `;
    return Number(row?.count ?? 0);
  }

  /** Raw-inserts a page row, bypassing every engine guarantee -- used to
   * set up a decoy collision or a cross-locale sibling this package's own
   * write paths would never produce, exactly like the tracer test's raw
   * `page_blocks` inserts for its degraded-node fixtures. */
  async function insertRawPage(input: {
    readonly translationGroup?: string;
    readonly locale: string;
    readonly parentPageId: string | null;
    readonly slug: string;
    readonly path: string;
    readonly title: string;
    readonly status?: 'draft' | 'published';
    readonly resolvedPath?: string | null;
  }): Promise<string> {
    const now = clock().toISOString();
    const [row] = await handle.sql<{ id: string }[]>`
      INSERT INTO pages (
        translation_group, locale, parent_page_id, slug, slug_source, path,
        resolved_path, title, status, version, created_at, updated_at
      ) VALUES (
        ${input.translationGroup ?? randomUUID()}, ${input.locale},
        ${input.parentPageId}, ${input.slug}, 'manual', ${input.path},
        ${input.resolvedPath ?? null}, ${input.title},
        ${input.status ?? 'draft'}, 1, ${now}, ${now}
      ) RETURNING id
    `;
    if (row === undefined) {
      throw new Error('raw page insert returned no row');
    }
    return row.id;
  }

  it('creates a root page whose path equals its slug', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Home',
    });
    expect(page.slug).toBe('home');
    expect(page.path).toBe('home');
    expect(page.parentPageId).toBeNull();
  });

  it('composes a child page path as parentPath/slug', async () => {
    const parent = await createPage(deps, actor, {
      locale: 'en',
      title: 'Products',
    });
    const child = await createPage(deps, actor, {
      locale: 'en',
      title: 'Widgets',
      parentPageId: parent.id,
    });
    expect(child.path).toBe('products/widgets');
  });

  it('resolves a generated slug clash with -2, -3 and rejects a manual clash', async () => {
    const first = await createPage(deps, actor, {
      locale: 'en',
      title: 'Clash Test',
    });
    expect(first.slug).toBe('clash-test');

    const second = await createPage(deps, actor, {
      locale: 'en',
      title: 'Clash Test',
    });
    expect(second.slug).toBe('clash-test-2');

    const third = await createPage(deps, actor, {
      locale: 'en',
      title: 'Clash Test',
    });
    expect(third.slug).toBe('clash-test-3');

    const manualError: unknown = await createPage(deps, actor, {
      locale: 'en',
      title: 'Something else entirely',
      slug: 'clash-test',
    }).catch((caught: unknown) => caught);
    expect(manualError).toBeInstanceOf(PageSlugConflictError);
  });

  it('lets two sibling pages in different locales share a slug, and a root and a child share one', async () => {
    const enPage = await createPage(deps, actor, {
      locale: 'en',
      title: 'About',
    });
    const nlPage = await createPage(deps, actor, {
      locale: 'nl',
      title: 'About',
    });
    expect(enPage.slug).toBe('about');
    expect(nlPage.slug).toBe('about');
    expect(enPage.path).toBe('about');
    expect(nlPage.path).toBe('about');

    const enChild = await createPage(deps, actor, {
      locale: 'en',
      title: 'About',
      parentPageId: enPage.id,
    });
    expect(enChild.slug).toBe('about');
    expect(enChild.path).toBe('about/about');
  });

  it('eight concurrent creates under the same parent and locale all resolve to eight distinct slugs', async () => {
    const parent = await createPage(deps, actor, {
      locale: 'en',
      title: 'Race Parent',
    });
    const RACER_COUNT = 8;

    const results = await Promise.all(
      Array.from({ length: RACER_COUNT }, () =>
        createPage(deps, actor, {
          locale: 'en',
          title: 'Racer',
          parentPageId: parent.id,
        }),
      ),
    );

    expect(results).toHaveLength(RACER_COUNT);
    const slugs = results.map((page) => page.slug);
    expect(new Set(slugs).size).toBe(RACER_COUNT);
    expect(slugs).toContain('racer');
  });

  it('getPageByPath and listChildPages read what createPage wrote', async () => {
    const parent = await createPage(deps, actor, {
      locale: 'en',
      title: 'Read Parent',
    });
    const childB = await createPage(deps, actor, {
      locale: 'en',
      title: 'Bravo',
      parentPageId: parent.id,
    });
    const childA = await createPage(deps, actor, {
      locale: 'en',
      title: 'Alpha',
      parentPageId: parent.id,
    });

    const byPath = await getPageByPath(db, {
      locale: 'en',
      path: 'read-parent/bravo',
    });
    expect(byPath?.id).toBe(childB.id);

    const missing = await getPageByPath(db, {
      locale: 'en',
      path: 'read-parent/nope',
    });
    expect(missing).toBeNull();

    const children = await listChildPages(db, {
      parentPageId: parent.id,
      locale: 'en',
    });
    expect(children.map((child) => child.id)).toEqual([childA.id, childB.id]);
  });

  it('moves a subtree under a new parent, rewriting every path, bumping every version, and recording history with reason "moved"', async () => {
    const company = await createPage(deps, actor, {
      locale: 'en',
      title: 'Company',
    });
    const about = await createPage(deps, actor, {
      locale: 'en',
      title: 'About Move',
    });
    const team = await createPage(deps, actor, {
      locale: 'en',
      title: 'Team',
      parentPageId: about.id,
    });
    const history = await createPage(deps, actor, {
      locale: 'en',
      title: 'History',
      parentPageId: team.id,
    });

    const oldAboutPath = about.path;
    const oldTeamPath = team.path;
    const oldHistoryPath = history.path;

    const moved = await movePage(deps, actor, {
      pageId: about.id,
      baseVersion: about.version,
      newParentPageId: company.id,
    });
    expect(moved.parentPageId).toBe(company.id);
    expect(moved.path).toBe('company/about-move');
    expect(moved.version).toBe(about.version + 1);

    const teamAfter = await getPage(db, team.id);
    const historyAfter = await getPage(db, history.id);
    expect(teamAfter?.path).toBe('company/about-move/team');
    expect(historyAfter?.path).toBe('company/about-move/team/history');
    expect(teamAfter?.version).toBe(team.version + 1);
    expect(historyAfter?.version).toBe(history.version + 1);
    // A descendant's own parent link never changes -- only the moved
    // page's `parent_page_id` does.
    expect(teamAfter?.parentPageId).toBe(about.id);

    expect(await historyRows(about.id)).toEqual([
      { oldPath: oldAboutPath, reason: 'moved' },
    ]);
    expect(await historyRows(team.id)).toEqual([
      { oldPath: oldTeamPath, reason: 'moved' },
    ]);
    expect(await historyRows(history.id)).toEqual([
      { oldPath: oldHistoryPath, reason: 'moved' },
    ]);
  });

  it('rewrites a page with 20 descendants in one batched statement', async () => {
    const oldRoot = await createPage(deps, actor, {
      locale: 'en',
      title: 'Big Root',
    });
    const newRoot = await createPage(deps, actor, {
      locale: 'en',
      title: 'Big Destination',
    });
    const CHILD_COUNT = 20;
    const children: PageRecord[] = [];
    for (let index = 0; index < CHILD_COUNT; index += 1) {
      // Sequential on purpose: each create takes the page-slug advisory
      // lock under the same (locale, parent) pair anyway.
      children.push(
        await createPage(deps, actor, {
          locale: 'en',
          title: `Child ${index}`,
          parentPageId: oldRoot.id,
        }),
      );
    }

    const moved = await movePage(deps, actor, {
      pageId: oldRoot.id,
      baseVersion: oldRoot.version,
      newParentPageId: newRoot.id,
    });
    expect(moved.path).toBe('big-destination/big-root');

    for (const child of children) {
      const after = await getPage(db, child.id);
      expect(after?.path).toBe(`big-destination/big-root/${child.slug}`);
      expect(after?.version).toBe(child.version + 1);
    }
  });

  it('renaming a page slug rewrites its descendants too, with reason "slug_changed"', async () => {
    const parent = await createPage(deps, actor, {
      locale: 'en',
      title: 'Rename Parent',
    });
    const child = await createPage(deps, actor, {
      locale: 'en',
      title: 'Rename Child',
      parentPageId: parent.id,
    });
    const oldParentPath = parent.path;
    const oldChildPath = child.path;

    const renamed = await renamePage(deps, actor, {
      pageId: parent.id,
      baseVersion: parent.version,
      slug: 'renamed-parent',
    });
    expect(renamed.path).toBe('renamed-parent');
    expect(renamed.slugSource).toBe('manual');

    const childAfter = await getPage(db, child.id);
    expect(childAfter?.path).toBe('renamed-parent/rename-child');
    expect(childAfter?.version).toBe(child.version + 1);

    expect(await historyRows(parent.id)).toEqual([
      { oldPath: oldParentPath, reason: 'slug_changed' },
    ]);
    expect(await historyRows(child.id)).toEqual([
      { oldPath: oldChildPath, reason: 'slug_changed' },
    ]);
  });

  it('a title-only rename bumps the version but writes no URL history and leaves the path untouched', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Title Only',
    });

    const renamed = await renamePage(deps, actor, {
      pageId: page.id,
      baseVersion: page.version,
      title: 'Title Only, Updated',
    });
    expect(renamed.path).toBe(page.path);
    expect(renamed.title).toBe('Title Only, Updated');
    expect(renamed.version).toBe(page.version + 1);
    expect(await historyRows(page.id)).toEqual([]);
  });

  it('refuses a move whose destination path collides with an existing page, writing nothing', async () => {
    const decoyParent = await createPage(deps, actor, {
      locale: 'en',
      title: 'Decoy Root',
    });
    await createPage(deps, actor, {
      locale: 'en',
      title: 'Taken',
      parentPageId: decoyParent.id,
    });
    const mover = await createPage(deps, actor, {
      locale: 'en',
      title: 'Taken',
    });

    const historyCountBefore = await historyRowCount();
    const error: unknown = await movePage(deps, actor, {
      pageId: mover.id,
      baseVersion: mover.version,
      newParentPageId: decoyParent.id,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PagePathConflictError);
    expect(await historyRowCount()).toBe(historyCountBefore);

    const moverAfter = await getPage(db, mover.id);
    expect(moverAfter?.parentPageId).toBeNull();
    expect(moverAfter?.version).toBe(mover.version);
  });

  it('refuses a move whose descendant (not the moved page itself) collides, checking the whole subtree before any write', async () => {
    const destination = await createPage(deps, actor, {
      locale: 'en',
      title: 'Descendant Collision Destination',
    });
    // A decoy occupying exactly where the mover's *child* would land --
    // the mover's own destination path is free, so a check that only
    // looked at the moved page's own path would miss this collision.
    const decoyPath = `${destination.path}/descendant-collision-mover/collides`;
    await insertRawPage({
      locale: 'en',
      parentPageId: null,
      slug: 'collides',
      path: decoyPath,
      title: 'Decoy',
    });

    const mover = await createPage(deps, actor, {
      locale: 'en',
      title: 'Descendant Collision Mover',
    });
    await createPage(deps, actor, {
      locale: 'en',
      title: 'Collides',
      parentPageId: mover.id,
    });

    const historyCountBefore = await historyRowCount();
    const error: unknown = await movePage(deps, actor, {
      pageId: mover.id,
      baseVersion: mover.version,
      newParentPageId: destination.id,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PagePathConflictError);
    expect(await historyRowCount()).toBe(historyCountBefore);
    expect((await getPage(db, mover.id))?.parentPageId).toBeNull();
  });

  it('refuses moving a page under its own descendant, writing nothing', async () => {
    const root = await createPage(deps, actor, {
      locale: 'en',
      title: 'Circular Root',
    });
    const child = await createPage(deps, actor, {
      locale: 'en',
      title: 'Circular Child',
      parentPageId: root.id,
    });

    const historyCountBefore = await historyRowCount();
    const error: unknown = await movePage(deps, actor, {
      pageId: root.id,
      baseVersion: root.version,
      newParentPageId: child.id,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CircularPageMoveError);
    expect(await historyRowCount()).toBe(historyCountBefore);
    expect((await getPage(db, root.id))?.parentPageId).toBeNull();
  });

  it('moves a page to the root, producing a path equal to its slug', async () => {
    const parent = await createPage(deps, actor, {
      locale: 'en',
      title: 'Root Move Parent',
    });
    const child = await createPage(deps, actor, {
      locale: 'en',
      title: 'Root Move Child',
      parentPageId: parent.id,
    });

    const moved = await movePage(deps, actor, {
      pageId: child.id,
      baseVersion: child.version,
      newParentPageId: null,
    });
    expect(moved.parentPageId).toBeNull();
    expect(moved.path).toBe(child.slug);
  });

  it('refuses a move from a stale baseVersion, writing nothing', async () => {
    const destination = await createPage(deps, actor, {
      locale: 'en',
      title: 'Stale Destination',
    });
    const mover = await createPage(deps, actor, {
      locale: 'en',
      title: 'Stale Mover',
    });

    const error: unknown = await movePage(deps, actor, {
      pageId: mover.id,
      baseVersion: mover.version + 1,
      newParentPageId: destination.id,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StalePageVersionError);
    expect((await getPage(db, mover.id))?.parentPageId).toBeNull();
  });

  it('never touches a page in another locale, even one sharing the same translation_group', async () => {
    const enPage = await createPage(deps, actor, {
      locale: 'en',
      title: 'Locale Isolation',
    });
    const enPageRow = await getPage(db, enPage.id);
    const translationGroup = enPageRow?.translationGroup ?? '';
    const nlPageId = await insertRawPage({
      translationGroup,
      locale: 'nl',
      parentPageId: null,
      slug: 'andere-titel',
      path: 'andere-titel',
      title: 'Andere Titel',
    });
    const destination = await createPage(deps, actor, {
      locale: 'en',
      title: 'Locale Isolation Destination',
    });

    await movePage(deps, actor, {
      pageId: enPage.id,
      baseVersion: enPage.version,
      newParentPageId: destination.id,
    });

    const nlAfter = await getPage(db, nlPageId);
    expect(nlAfter?.path).toBe('andere-titel');
    expect(nlAfter?.parentPageId).toBeNull();
    expect(nlAfter?.version).toBe(1);
  });

  it("clears a moved page's stale resolved_path (T-04-43)", async () => {
    const destination = await createPage(deps, actor, {
      locale: 'en',
      title: 'Resolved Path Destination',
    });
    const mover = await createPage(deps, actor, {
      locale: 'en',
      title: 'Resolved Path Mover',
    });
    await handle.sql`
      UPDATE pages SET status = 'published', resolved_path = 'en/resolved-path-mover'
      WHERE id = ${mover.id}
    `;

    const moved = await movePage(deps, actor, {
      pageId: mover.id,
      baseVersion: mover.version,
      newParentPageId: destination.id,
    });
    expect(moved.resolvedPath).toBeNull();
  });
});
