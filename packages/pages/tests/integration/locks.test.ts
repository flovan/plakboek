/**
 * The page+locale edit lock's write guard, proven against real Postgres
 * (04-14-PLAN.md Task 2): acquire/renew/release/re-acquire, a lock conflict
 * refusing with no denied audit row, every write path in this package
 * refusing for a non-holder and succeeding for the holder and for anyone
 * once the lock has lapsed, the version-before-lock ordering, two
 * translation-group locales locked independently, the project-wide toggle
 * (D-40), `trashPage` refusing on a locked descendant, and takeover (D-44)
 * including the TTL-boundary race.
 */
import { randomUUID } from 'node:crypto';
import {
  createAuditRecorder,
  createUserWithRole,
  SUPERADMIN_ROLE_KEY,
  type AuditActor,
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
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definePagesConfig, type PagesDeps } from '../../src/config.js';
import {
  deletePagePermanently,
  restorePageFromTrash,
  schedulePage,
  trashPage,
  unpublishPage,
  unschedulePage,
} from '../../src/lifecycle.js';
import {
  acquirePageLock,
  PAGE_EDIT_LOCK_TTL_SECONDS,
  PageLockedError,
  PageLockingDisabledError,
  PageLockStateChangedError,
  PageLockTakeoverForbiddenError,
  releasePageLock,
  renewPageLock,
  takeOverPageLock,
} from '../../src/locks.js';
import {
  createPage,
  getPage,
  movePage,
  renamePage,
  StalePageVersionError,
} from '../../src/pages.js';
import { createDraftSnapshot, publishPage } from '../../src/publish.js';
import { defineBlocks } from '../../src/registry.js';
import { restoreRevisionBatch } from '../../src/revisions.js';
import { blockRevisions } from '../../src/schema.js';
import { setPageEditLocking } from '../../src/settings.js';
import { createPageTranslation } from '../../src/translations.js';
import {
  deleteBlock,
  insertBlock,
  moveBlock,
  updateBlockProps,
} from '../../src/tree.js';
import type { OwnerRef, PageRecord } from '../../src/types.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const roles = defineRoles({
  ...defaultRoles,
  // Holds `pages:edit` (so `deps.recorder.run`'s own permission gate
  // passes) but is nowhere near a permission superset of `editor` -- used
  // only for the takeover TTL-boundary race, mirroring
  // `@plakboek/content`'s own `author` role for the identical WR-01 test.
  'page-assistant': ['pages:read', 'pages:edit'],
});

const BLOCKS_CONFIG = defineBlocks([
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
    properties: { text: { fieldType: 'short_text', label: 'Text' } },
  },
]);

function ownerOf(pageId: string, locale: string): OwnerRef {
  return { ownerType: 'page', ownerId: pageId, locale };
}

async function mustGetPage(
  deps: PagesDeps,
  pageId: string,
): Promise<PageRecord> {
  const page = await getPage(deps.db, pageId);
  if (page === null) throw new Error(`page "${pageId}" vanished mid-test`);
  return page;
}

/** One call site this plan wires the guard into. `build` creates a fresh
 * page (and whatever tree/status it needs) as `creator`, returning a thunk
 * that performs the write itself as `actor` -- fixture construction and the
 * write are separate so a lock can be acquired (or the toggle flipped) in
 * between, and the same table drives the refused/holder-succeeds/lapsed/
 * locking-off scenarios below without four hand-written copies. */
type CallSite = {
  readonly name: string;
  readonly build: (
    deps: PagesDeps,
    creator: AuditActor,
  ) => Promise<{
    readonly pageId: string;
    readonly call: (deps: PagesDeps, actor: AuditActor) => Promise<unknown>;
  }>;
};

const CALL_SITES: readonly CallSite[] = [
  {
    name: 'insertBlock',
    build: async (deps, creator) => {
      const page = await createPage(deps, creator, {
        locale: 'en',
        title: `insertBlock ${randomUUID()}`,
      });
      const owner = ownerOf(page.id, 'en');
      const section = await insertBlock(deps, creator, {
        owner,
        blockType: 'section',
        parentBlockId: null,
        basePageVersion: page.version,
      });
      const fresh = await mustGetPage(deps, page.id);
      return {
        pageId: page.id,
        call: (deps2, actor) =>
          insertBlock(deps2, actor, {
            owner,
            blockType: 'heading',
            parentBlockId: section.id,
            props: { text: 'x' },
            basePageVersion: fresh.version,
          }),
      };
    },
  },
  {
    name: 'updateBlockProps',
    build: async (deps, creator) => {
      const page = await createPage(deps, creator, {
        locale: 'en',
        title: `updateBlockProps ${randomUUID()}`,
      });
      const owner = ownerOf(page.id, 'en');
      const section = await insertBlock(deps, creator, {
        owner,
        blockType: 'section',
        parentBlockId: null,
        basePageVersion: page.version,
      });
      const afterSection = await mustGetPage(deps, page.id);
      const child = await insertBlock(deps, creator, {
        owner,
        blockType: 'heading',
        parentBlockId: section.id,
        props: { text: 'a' },
        basePageVersion: afterSection.version,
      });
      return {
        pageId: page.id,
        call: (deps2, actor) =>
          updateBlockProps(deps2, actor, {
            blockId: child.id,
            baseVersion: child.version,
            props: { text: 'b' },
          }),
      };
    },
  },
  {
    name: 'moveBlock',
    build: async (deps, creator) => {
      const page = await createPage(deps, creator, {
        locale: 'en',
        title: `moveBlock ${randomUUID()}`,
      });
      const owner = ownerOf(page.id, 'en');
      const section1 = await insertBlock(deps, creator, {
        owner,
        blockType: 'section',
        parentBlockId: null,
        basePageVersion: page.version,
      });
      let fresh = await mustGetPage(deps, page.id);
      const section2 = await insertBlock(deps, creator, {
        owner,
        blockType: 'section',
        parentBlockId: null,
        basePageVersion: fresh.version,
      });
      fresh = await mustGetPage(deps, page.id);
      const child = await insertBlock(deps, creator, {
        owner,
        blockType: 'heading',
        parentBlockId: section1.id,
        props: { text: 'a' },
        basePageVersion: fresh.version,
      });
      fresh = await mustGetPage(deps, page.id);
      return {
        pageId: page.id,
        call: (deps2, actor) =>
          moveBlock(deps2, actor, {
            blockId: child.id,
            baseVersion: child.version,
            pageId: page.id,
            basePageVersion: fresh.version,
            newParentBlockId: section2.id,
          }),
      };
    },
  },
  {
    name: 'deleteBlock',
    build: async (deps, creator) => {
      const page = await createPage(deps, creator, {
        locale: 'en',
        title: `deleteBlock ${randomUUID()}`,
      });
      const owner = ownerOf(page.id, 'en');
      const section = await insertBlock(deps, creator, {
        owner,
        blockType: 'section',
        parentBlockId: null,
        basePageVersion: page.version,
      });
      const afterSection = await mustGetPage(deps, page.id);
      const child = await insertBlock(deps, creator, {
        owner,
        blockType: 'heading',
        parentBlockId: section.id,
        props: { text: 'a' },
        basePageVersion: afterSection.version,
      });
      const fresh = await mustGetPage(deps, page.id);
      return {
        pageId: page.id,
        call: (deps2, actor) =>
          deleteBlock(deps2, actor, {
            blockId: child.id,
            baseVersion: child.version,
            pageId: page.id,
            basePageVersion: fresh.version,
          }),
      };
    },
  },
  {
    name: 'renamePage',
    build: async (deps, creator) => {
      const page = await createPage(deps, creator, {
        locale: 'en',
        title: `renamePage ${randomUUID()}`,
      });
      return {
        pageId: page.id,
        call: (deps2, actor) =>
          renamePage(deps2, actor, {
            pageId: page.id,
            baseVersion: page.version,
            title: 'Renamed',
          }),
      };
    },
  },
  {
    name: 'movePage',
    build: async (deps, creator) => {
      const destination = await createPage(deps, creator, {
        locale: 'en',
        title: `movePage destination ${randomUUID()}`,
      });
      const page = await createPage(deps, creator, {
        locale: 'en',
        title: `movePage ${randomUUID()}`,
      });
      return {
        pageId: page.id,
        call: (deps2, actor) =>
          movePage(deps2, actor, {
            pageId: page.id,
            baseVersion: page.version,
            newParentPageId: destination.id,
          }),
      };
    },
  },
  {
    name: 'publishPage',
    build: async (deps, creator) => {
      const page = await createPage(deps, creator, {
        locale: 'en',
        title: `publishPage ${randomUUID()}`,
      });
      const owner = ownerOf(page.id, 'en');
      await insertBlock(deps, creator, {
        owner,
        blockType: 'section',
        parentBlockId: null,
        basePageVersion: page.version,
      });
      const fresh = await mustGetPage(deps, page.id);
      return {
        pageId: page.id,
        call: (deps2, actor) =>
          publishPage(deps2, actor, {
            pageId: page.id,
            baseVersion: fresh.version,
          }),
      };
    },
  },
  {
    name: 'createDraftSnapshot',
    build: async (deps, creator) => {
      const page = await createPage(deps, creator, {
        locale: 'en',
        title: `createDraftSnapshot ${randomUUID()}`,
      });
      const owner = ownerOf(page.id, 'en');
      await insertBlock(deps, creator, {
        owner,
        blockType: 'section',
        parentBlockId: null,
        basePageVersion: page.version,
      });
      return {
        pageId: page.id,
        call: (deps2, actor) =>
          createDraftSnapshot(deps2, actor, { pageId: page.id }),
      };
    },
  },
  {
    name: 'unpublishPage',
    build: async (deps, creator) => {
      const page = await createPage(deps, creator, {
        locale: 'en',
        title: `unpublishPage ${randomUUID()}`,
      });
      const owner = ownerOf(page.id, 'en');
      await insertBlock(deps, creator, {
        owner,
        blockType: 'section',
        parentBlockId: null,
        basePageVersion: page.version,
      });
      const beforePublish = await mustGetPage(deps, page.id);
      await publishPage(deps, creator, {
        pageId: page.id,
        baseVersion: beforePublish.version,
      });
      const fresh = await mustGetPage(deps, page.id);
      return {
        pageId: page.id,
        call: (deps2, actor) =>
          unpublishPage(deps2, actor, {
            pageId: page.id,
            baseVersion: fresh.version,
          }),
      };
    },
  },
  {
    name: 'schedulePage',
    build: async (deps, creator) => {
      const page = await createPage(deps, creator, {
        locale: 'en',
        title: `schedulePage ${randomUUID()}`,
      });
      return {
        pageId: page.id,
        call: (deps2, actor) => {
          const clockNow = deps2.now?.() ?? new Date();
          return schedulePage(deps2, actor, {
            pageId: page.id,
            baseVersion: page.version,
            scheduledAt: new Date(clockNow.getTime() + 3_600_000),
          });
        },
      };
    },
  },
  {
    name: 'unschedulePage',
    build: async (deps, creator) => {
      const page = await createPage(deps, creator, {
        locale: 'en',
        title: `unschedulePage ${randomUUID()}`,
      });
      const clockNow = deps.now?.() ?? new Date();
      const scheduled = await schedulePage(deps, creator, {
        pageId: page.id,
        baseVersion: page.version,
        scheduledAt: new Date(clockNow.getTime() + 3_600_000),
      });
      return {
        pageId: page.id,
        call: (deps2, actor) =>
          unschedulePage(deps2, actor, {
            pageId: page.id,
            baseVersion: scheduled.version,
          }),
      };
    },
  },
  {
    name: 'trashPage',
    build: async (deps, creator) => {
      const page = await createPage(deps, creator, {
        locale: 'en',
        title: `trashPage ${randomUUID()}`,
      });
      return {
        pageId: page.id,
        call: (deps2, actor) =>
          trashPage(deps2, actor, {
            pageId: page.id,
            baseVersion: page.version,
          }),
      };
    },
  },
  {
    name: 'restorePageFromTrash',
    build: async (deps, creator) => {
      const page = await createPage(deps, creator, {
        locale: 'en',
        title: `restorePageFromTrash ${randomUUID()}`,
      });
      const trashed = await trashPage(deps, creator, {
        pageId: page.id,
        baseVersion: page.version,
      });
      return {
        pageId: page.id,
        call: (deps2, actor) =>
          restorePageFromTrash(deps2, actor, {
            pageId: page.id,
            baseVersion: trashed.version,
          }),
      };
    },
  },
  {
    name: 'deletePagePermanently',
    build: async (deps, creator) => {
      const page = await createPage(deps, creator, {
        locale: 'en',
        title: `deletePagePermanently ${randomUUID()}`,
      });
      return {
        pageId: page.id,
        call: (deps2, actor) =>
          deletePagePermanently(deps2, actor, {
            pageId: page.id,
            baseVersion: page.version,
          }),
      };
    },
  },
  {
    // Code review CR-01: `restoreRevisionBatch` (revisions.ts) writes
    // `page_blocks` rows and bumps `pages.version` exactly like every other
    // structural write in this package, but shipped (04-08) before the page
    // edit lock (04-14) existed, so it was never wired into this call-site
    // table -- the exact gap the review caught.
    name: 'restoreRevisionBatch',
    build: async (deps, creator) => {
      const page = await createPage(deps, creator, {
        locale: 'en',
        title: `restoreRevisionBatch ${randomUUID()}`,
      });
      const owner = ownerOf(page.id, 'en');
      const section = await insertBlock(deps, creator, {
        owner,
        blockType: 'section',
        parentBlockId: null,
        basePageVersion: page.version,
      });
      const [revisionRow] = await deps.db
        .select({ revisionBatchId: blockRevisions.revisionBatchId })
        .from(blockRevisions)
        .where(
          and(
            eq(blockRevisions.blockId, section.id),
            eq(blockRevisions.changeType, 'create'),
          ),
        );
      const revisionBatchId = revisionRow!.revisionBatchId;
      const fresh = await mustGetPage(deps, page.id);
      return {
        pageId: page.id,
        call: (deps2, actor) =>
          restoreRevisionBatch(deps2, actor, {
            revisionBatchId,
            pageId: page.id,
            basePageVersion: fresh.version,
          }),
      };
    },
  },
];

describe('page+locale edit locking: the write guard, proven against real Postgres (D-39, D-41, 03 D-43/44/45)', () => {
  let testDatabase: TestDatabase;
  let handle: Db;
  let deps: PagesDeps;
  let currentTime = new Date('2026-09-28T09:00:00.000Z');
  const clock = {
    now: (): Date => currentTime,
    advance(seconds: number): void {
      currentTime = new Date(currentTime.getTime() + seconds * 1000);
    },
  };

  let userA: AuditActor;
  let userB: AuditActor;
  let editorUser: AuditActor;
  let superadminHolder: AuditActor;
  let pageAssistant: AuditActor;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });

    const resolver: PermissionResolver = createPermissionResolver(roles);
    const recorder: AuditRecorder = createAuditRecorder({
      db: handle.db,
      resolver,
    });
    const config = definePagesConfig({
      content: defineContentConfig({
        locales: ['en', 'nl'],
        defaultLocale: 'en',
        timezone: 'UTC',
      }),
      blocks: BLOCKS_CONFIG,
    });

    async function makeUser(
      email: string,
      roleKey: string,
    ): Promise<AuditActor> {
      const created = await createUserWithRole(handle.db, {
        id: randomUUID(),
        email,
        name: email,
        roleKey,
      });
      return { userId: created.userId, roleKey: created.roleKey };
    }

    userA = await makeUser('lock-user-a@example.com', SUPERADMIN_ROLE_KEY);
    userB = await makeUser('lock-user-b@example.com', SUPERADMIN_ROLE_KEY);
    editorUser = await makeUser('lock-editor@example.com', 'editor');
    superadminHolder = await makeUser(
      'lock-superadmin-holder@example.com',
      SUPERADMIN_ROLE_KEY,
    );
    pageAssistant = await makeUser(
      'lock-assistant@example.com',
      'page-assistant',
    );

    deps = { db: handle.db, recorder, resolver, config, now: clock.now };
  });

  afterAll(async () => {
    await handle.close();
    await testDatabase.drop();
  });

  async function auditRowCount(
    action: string,
    outcome: 'allowed' | 'denied',
  ): Promise<number> {
    const [row] = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log
      WHERE action = ${action} AND outcome = ${outcome}
    `;
    return Number(row?.count ?? '0');
  }

  it('acquires, renews, releases, and a second user re-acquires after the release -- none of acquire/renew/release write a success audit row (heartbeat-flood avoidance, mirrors @plakboek/content)', async () => {
    const page = await createPage(deps, userA, {
      locale: 'en',
      title: `Lifecycle ${randomUUID()}`,
    });

    const acquireAllowedBefore = await auditRowCount(
      'page.lock-acquire',
      'allowed',
    );
    const grant = await acquirePageLock(deps, userA, { pageId: page.id });
    expect(grant.expiresAt.getTime()).toBe(
      grant.lockedAt.getTime() + PAGE_EDIT_LOCK_TTL_SECONDS * 1000,
    );
    expect(await auditRowCount('page.lock-acquire', 'allowed')).toBe(
      acquireAllowedBefore,
    );

    const renewAllowedBefore = await auditRowCount(
      'page.lock-renew',
      'allowed',
    );
    expect(await renewPageLock(deps, userA, { pageId: page.id })).toBe(true);
    expect(await auditRowCount('page.lock-renew', 'allowed')).toBe(
      renewAllowedBefore,
    );

    const releaseAllowedBefore = await auditRowCount(
      'page.lock-release',
      'allowed',
    );
    expect(await releasePageLock(deps, userA, { pageId: page.id })).toBe(true);
    expect(await auditRowCount('page.lock-release', 'allowed')).toBe(
      releaseAllowedBefore,
    );

    await acquirePageLock(deps, userB, { pageId: page.id });
    const afterReacquire = await mustGetPage(deps, page.id);
    expect(afterReacquire.lockedBy).toBe(userB.userId);

    // Clean up so a later test acquiring the same (long-lived actor
    // identity, fresh page) isn't affected.
    await releasePageLock(deps, userB, { pageId: page.id });
  });

  it("a second user's acquirePageLock is refused while the first holds a live lock -- a lock conflict is not a permission refusal, so no denied row is written", async () => {
    const page = await createPage(deps, userA, {
      locale: 'en',
      title: `Conflict ${randomUUID()}`,
    });
    await acquirePageLock(deps, userA, { pageId: page.id });

    const deniedBefore = await auditRowCount('page.lock-acquire', 'denied');
    const error: unknown = await acquirePageLock(deps, userB, {
      pageId: page.id,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PageLockedError);
    expect(error).toMatchObject({ holderUserId: userA.userId });
    expect(await auditRowCount('page.lock-acquire', 'denied')).toBe(
      deniedBefore,
    );
  });

  it('a stale baseVersion reports StalePageVersionError before the lock check, even while a colleague holds a live lock (D-42-before-D-43/45 ordering)', async () => {
    const page = await createPage(deps, userA, {
      locale: 'en',
      title: `Ordering ${randomUUID()}`,
    });
    await acquirePageLock(deps, userB, { pageId: page.id });

    const error: unknown = await renamePage(deps, userA, {
      pageId: page.id,
      baseVersion: page.version + 999,
      title: 'Should not land',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StalePageVersionError);
  });

  it('two locales of one translation group are locked by two different users simultaneously, each editing their own tree without interference (D-39, 03 D-45)', async () => {
    const enPage = await createPage(deps, userA, {
      locale: 'en',
      title: `Dual locale ${randomUUID()}`,
    });
    const nlPage = await createPageTranslation(deps, userA, {
      pageId: enPage.id,
      locale: 'nl',
    });

    await acquirePageLock(deps, userA, { pageId: enPage.id });
    await acquirePageLock(deps, userB, { pageId: nlPage.id });

    const enSection = await insertBlock(deps, userA, {
      owner: ownerOf(enPage.id, 'en'),
      blockType: 'section',
      parentBlockId: null,
      basePageVersion: enPage.version,
    });
    const nlSection = await insertBlock(deps, userB, {
      owner: ownerOf(nlPage.id, 'nl'),
      blockType: 'section',
      parentBlockId: null,
      basePageVersion: nlPage.version,
    });
    expect(enSection.ownerId).toBe(enPage.id);
    expect(nlSection.ownerId).toBe(nlPage.id);

    const nlFresh = await mustGetPage(deps, nlPage.id);
    const crossLocaleError: unknown = await insertBlock(deps, userA, {
      owner: ownerOf(nlPage.id, 'nl'),
      blockType: 'section',
      parentBlockId: null,
      basePageVersion: nlFresh.version,
    }).catch((caught: unknown) => caught);
    expect(crossLocaleError).toBeInstanceOf(PageLockedError);
  });

  it('trashPage is refused while a colleague holds a live lock on a descendant, checking the whole subtree not only the root', async () => {
    const parent = await createPage(deps, userA, {
      locale: 'en',
      title: `Trash parent ${randomUUID()}`,
    });
    const child = await createPage(deps, userA, {
      locale: 'en',
      title: `Trash child ${randomUUID()}`,
      parentPageId: parent.id,
    });
    await acquirePageLock(deps, userB, { pageId: child.id });

    const error: unknown = await trashPage(deps, userA, {
      pageId: parent.id,
      baseVersion: parent.version,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PageLockedError);

    const parentAfter = await mustGetPage(deps, parent.id);
    expect(parentAfter.status).not.toBe('trashed');
  });

  describe('every write path honours the guard, per call site (one case per call site)', () => {
    it.each(CALL_SITES)(
      '$name: refused with PageLockedError for a non-holder while userA holds a live lock, changing nothing',
      async (site) => {
        const { pageId, call } = await site.build(deps, userA);
        await acquirePageLock(deps, userA, { pageId });

        const before = await mustGetPage(deps, pageId);
        const error: unknown = await call(deps, userB).catch(
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(PageLockedError);

        const after = await mustGetPage(deps, pageId);
        expect(after.version).toBe(before.version);
      },
    );

    it.each(CALL_SITES)(
      '$name: succeeds for the holder while holding the lock',
      async (site) => {
        const { pageId, call } = await site.build(deps, userA);
        await acquirePageLock(deps, userA, { pageId });

        const result = await call(deps, userA);
        expect(result).toBeDefined();
      },
    );

    it.each(CALL_SITES)(
      '$name: succeeds for anyone once the lock has lapsed (injected clock, not a real wait)',
      async (site) => {
        const { pageId, call } = await site.build(deps, userA);
        await acquirePageLock(deps, userA, { pageId });
        clock.advance(PAGE_EDIT_LOCK_TTL_SECONDS + 1);

        const result = await call(deps, userB);
        expect(result).toBeDefined();
      },
    );
  });

  describe('takeover (D-44): permission superset, denied refusal, and the TTL-boundary race', () => {
    it('a superadmin takes over an editors lock: succeeds, bumps version, one allowed audit row', async () => {
      const page = await createPage(deps, userA, {
        locale: 'en',
        title: `Takeover allowed ${randomUUID()}`,
      });
      await acquirePageLock(deps, editorUser, { pageId: page.id });

      const allowedBefore = await auditRowCount(
        'page.lock-takeover',
        'allowed',
      );
      const takenOver = await takeOverPageLock(deps, superadminHolder, {
        pageId: page.id,
      });
      expect(takenOver.lockedBy).toBe(superadminHolder.userId);
      expect(takenOver.version).toBe(page.version + 1);
      expect(await auditRowCount('page.lock-takeover', 'allowed')).toBe(
        allowedBefore + 1,
      );
    });

    it('an editor over a superadmins lock is refused: PageLockTakeoverForbiddenError, one denied audit row, lock unchanged', async () => {
      const page = await createPage(deps, userA, {
        locale: 'en',
        title: `Takeover forbidden ${randomUUID()}`,
      });
      await acquirePageLock(deps, superadminHolder, { pageId: page.id });

      const deniedBefore = await auditRowCount('page.lock-takeover', 'denied');
      const error: unknown = await takeOverPageLock(deps, editorUser, {
        pageId: page.id,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PageLockTakeoverForbiddenError);
      expect(await auditRowCount('page.lock-takeover', 'denied')).toBe(
        deniedBefore + 1,
      );

      const stillLocked = await mustGetPage(deps, page.id);
      expect(stillLocked.lockedBy).toBe(superadminHolder.userId);
    });

    it('refuses with PageLockStateChangedError when a holder that looked lapsed at pre-check time is live again by the time the takeover transaction reloads the row (WR-01)', async () => {
      const page = await createPage(deps, userA, {
        locale: 'en',
        title: `TTL race ${randomUUID()}`,
      });
      await acquirePageLock(deps, editorUser, { pageId: page.id });
      // Lapsed from the pre-check's point of view.
      clock.advance(PAGE_EDIT_LOCK_TTL_SECONDS + 1);

      const blocking = createDb({
        connectionString: testDatabase.connectionString,
        maxConnections: 1,
      });

      let resolveRenewSignal: () => void = () => {
        throw new Error('resolveRenewSignal called before it was assigned');
      };
      const renewSignal = new Promise<void>((resolve) => {
        resolveRenewSignal = resolve;
      });
      let signalHolderXid: (xid: string) => void = () => {
        throw new Error('signalHolderXid called before it was assigned');
      };
      const holderXidReady = new Promise<string>((resolve) => {
        signalHolderXid = resolve;
      });

      try {
        const blockingTxPromise = blocking.sql.begin(async (sql) => {
          const [row] = await sql`
            SELECT pg_current_xact_id()::xid::text AS xid
            FROM pages WHERE id = ${page.id} FOR UPDATE
          `;
          signalHolderXid(row?.xid ?? '');
          await renewSignal;
          await sql`
            UPDATE pages
            SET locked_at = ${clock.now().toISOString()}
            WHERE id = ${page.id}
          `;
        });

        const holderXid = await holderXidReady;

        const takeoverPromise = takeOverPageLock(deps, pageAssistant, {
          pageId: page.id,
        }).catch((caught: unknown) => caught);

        // Scoped to the holder's own xid -- pg_locks is server-wide, and
        // this suite's sibling integration files race against the same
        // Postgres server (STATE.md, Phase 3 decision).
        const deadline = Date.now() + 5000;
        let waitingCount = 0;
        while (waitingCount < 1 && Date.now() < deadline) {
          const [row] = await handle.sql<{ count: number }[]>`
            SELECT count(*)::int AS count FROM pg_locks
            WHERE NOT granted AND locktype = 'transactionid'
              AND transactionid = ${holderXid}::xid
          `;
          waitingCount = row?.count ?? 0;
        }
        if (waitingCount < 1) {
          throw new Error(
            'timed out waiting for the takeover to block on its FOR UPDATE reload',
          );
        }

        resolveRenewSignal();
        await blockingTxPromise;

        const takeoverResult: unknown = await takeoverPromise;
        expect(takeoverResult).toBeInstanceOf(PageLockStateChangedError);

        const stillHeld = await mustGetPage(deps, page.id);
        expect(stillHeld.lockedBy).toBe(editorUser.userId);
        expect(stillHeld.version).toBe(page.version);

        const retryError: unknown = await takeOverPageLock(
          deps,
          pageAssistant,
          {
            pageId: page.id,
          },
        ).catch((caught: unknown) => caught);
        expect(retryError).toBeInstanceOf(PageLockTakeoverForbiddenError);
      } finally {
        await blocking.close();
      }
    });
  });
});

describe('the project-wide toggle (D-40): with page edit locking off, every write path succeeds for a non-holder despite a live-looking lock pair', () => {
  let testDatabase: TestDatabase;
  let handle: Db;
  let deps: PagesDeps;
  let userA: AuditActor;
  let userB: AuditActor;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });

    const resolver: PermissionResolver = createPermissionResolver(roles);
    const recorder: AuditRecorder = createAuditRecorder({
      db: handle.db,
      resolver,
    });
    const config = definePagesConfig({
      content: defineContentConfig({
        locales: ['en', 'nl'],
        defaultLocale: 'en',
        timezone: 'UTC',
      }),
      blocks: BLOCKS_CONFIG,
    });

    async function makeUser(
      email: string,
      roleKey: string,
    ): Promise<AuditActor> {
      const created = await createUserWithRole(handle.db, {
        id: randomUUID(),
        email,
        name: email,
        roleKey,
      });
      return { userId: created.userId, roleKey: created.roleKey };
    }

    userA = await makeUser('toggle-user-a@example.com', SUPERADMIN_ROLE_KEY);
    userB = await makeUser('toggle-user-b@example.com', SUPERADMIN_ROLE_KEY);

    deps = { db: handle.db, recorder, resolver, config };

    await setPageEditLocking(deps, userA, { enabled: false });
  });

  afterAll(async () => {
    await handle.close();
    await testDatabase.drop();
  });

  it('acquirePageLock itself throws PageLockingDisabledError when the toggle is off', async () => {
    const page = await createPage(deps, userA, {
      locale: 'en',
      title: `Disabled ${randomUUID()}`,
    });
    const error: unknown = await acquirePageLock(deps, userA, {
      pageId: page.id,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PageLockingDisabledError);
  });

  it.each(CALL_SITES)(
    '$name: succeeds for a non-holder even with a live-looking locked_by/locked_at pair left on the row',
    async (site) => {
      const { pageId, call } = await site.build(deps, userA);
      await handle.sql`
        UPDATE pages
        SET locked_by = ${userA.userId}, locked_at = ${new Date().toISOString()}
        WHERE id = ${pageId}
      `;

      const result = await call(deps, userB);
      expect(result).toBeDefined();
    },
  );
});
