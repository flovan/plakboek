/**
 * Materialised addresses, collision refusal and the audited pattern change
 * (D-22), proven against real Postgres: publishing composes an address
 * through one project-wide pattern, a pattern change previews and refuses a
 * collision before writing anything, a successful change rewrites every
 * affected page in two batched statements with history recorded first, and
 * two concurrent changes serialise through the settings row's `FOR UPDATE`
 * lock.
 *
 * `setPageUrlPattern` recomputes over EVERY published page project-wide
 * (unlike `movePage`/`renamePage`, which are scoped to one subtree) --
 * every describe block that actually calls it gets its own freshly
 * migrated database, so one test's fixtures can never collide with
 * another's. Purely read-only checks (`assertPageAddressAvailable`,
 * `computeUrlPatternChangeImpact` previews, which never write) share one
 * database.
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
import {
  createPermissionResolver,
  defaultRoles,
  defineRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definePagesConfig, type PagesDeps } from '../../src/config.js';
import {
  assertPageAddressAvailable,
  computePageResolvedPath,
  computeUrlPatternChangeImpact,
  PageUrlCollisionError,
  PageUrlPatternCollisionError,
  setPageUrlPattern,
} from '../../src/page-routing.js';
import { PageUrlPatternError } from '../../src/page-url-pattern.js';
import { defineBlocks } from '../../src/registry.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

// A role that can create/read pages but never change the project-wide URL
// pattern -- `defaultRoles.editor` already holds `pages:publish`, so the
// permission-denied assertion needs its own purpose-built role, mirroring
// 04-02's tracer and 04-10's viewer role for the identical reason.
const roles = defineRoles({
  ...defaultRoles,
  'page-author': ['pages:read', 'pages:create', 'pages:edit'],
});

const CLOCK_TIME = new Date('2026-09-25T12:00:00.000Z');

type PagesTestEnvironment = {
  readonly testDatabase: TestDatabase;
  readonly handle: Db;
  readonly db: AuditDatabase;
  readonly deps: PagesDeps;
  readonly superadmin: AuditActor;
  readonly pageAuthor: AuditActor;
};

/** Spins up one freshly migrated database with the pages config and two
 * actors (a superadmin holding `pages:publish`, and a `pageAuthor` who does
 * not) -- the full environment every describe block below needs. */
async function setUpPagesTestEnvironment(): Promise<PagesTestEnvironment> {
  const testDatabase = await createTestDatabase();
  await runMigrations({ connectionString: testDatabase.connectionString });
  const handle = createDb({ connectionString: testDatabase.connectionString });
  const db: AuditDatabase = handle.db;

  const resolver: PermissionResolver = createPermissionResolver(roles);
  const recorder: AuditRecorder = createAuditRecorder({ db, resolver });
  const config = definePagesConfig({
    content: defineContentConfig({
      locales: ['en', 'nl'],
      defaultLocale: 'en',
      timezone: 'UTC',
    }),
    blocks: defineBlocks([
      {
        key: 'hero',
        editor: { label: 'Hero' },
        schemaVersion: 1,
        properties: {},
      },
    ]),
  });

  async function makeUser(email: string, roleKey: string): Promise<AuditActor> {
    const created = await createUserWithRole(db, {
      id: randomUUID(),
      email,
      name: email,
      roleKey,
    });
    return { userId: created.userId, roleKey: created.roleKey };
  }

  const superadmin = await makeUser(
    `${randomUUID()}@example.com`,
    SUPERADMIN_ROLE_KEY,
  );
  const pageAuthor = await makeUser(
    `${randomUUID()}@example.com`,
    'page-author',
  );

  const deps: PagesDeps = {
    db,
    recorder,
    resolver,
    config,
    now: () => CLOCK_TIME,
  };

  return { testDatabase, handle, db, deps, superadmin, pageAuthor };
}

async function tearDownPagesTestEnvironment(
  environment: PagesTestEnvironment,
): Promise<void> {
  await environment.handle.close();
  await environment.testDatabase.drop();
}

/** Raw-inserts a page row, bypassing every engine guarantee, including a
 * published page carrying whatever `resolvedPath` the scenario needs --
 * mirrors 04-10's own `insertRawPage` fixture helper. `path` and
 * `resolvedPath` are independent columns at the raw-SQL level, so a fixture
 * can set them to values that don't actually agree with any real pattern --
 * exactly what the swap discrimination scenario needs. */
async function insertRawPage(
  handle: Db,
  input: {
    readonly translationGroup?: string;
    readonly locale: string;
    readonly slug: string;
    readonly path: string;
    readonly title: string;
    readonly status?: 'draft' | 'published';
    readonly resolvedPath?: string | null;
  },
): Promise<string> {
  const now = CLOCK_TIME.toISOString();
  const [row] = await handle.sql<{ id: string }[]>`
    INSERT INTO pages (
      translation_group, locale, parent_page_id, slug, slug_source, path,
      resolved_path, title, status, version, created_at, updated_at
    ) VALUES (
      ${input.translationGroup ?? randomUUID()}, ${input.locale},
      NULL, ${input.slug}, 'manual', ${input.path},
      ${input.resolvedPath ?? null}, ${input.title},
      ${input.status ?? 'draft'}, 1, ${now}, ${now}
    ) RETURNING id
  `;
  if (row === undefined) {
    throw new Error('raw page insert returned no row');
  }
  return row.id;
}

async function getResolvedPath(
  handle: Db,
  pageId: string,
): Promise<string | null> {
  const [row] = await handle.sql<{ resolvedPath: string | null }[]>`
    SELECT resolved_path AS "resolvedPath" FROM pages WHERE id = ${pageId}
  `;
  return row?.resolvedPath ?? null;
}

async function getStoredUrlPattern(handle: Db): Promise<string> {
  const [row] = await handle.sql<{ urlPattern: string }[]>`
    SELECT url_pattern AS "urlPattern" FROM page_engine_settings WHERE id = 1
  `;
  if (row === undefined) throw new Error('page_engine_settings row missing');
  return row.urlPattern;
}

async function historyRows(
  handle: Db,
  pageId: string,
): Promise<{ oldPath: string; reason: string }[]> {
  return await handle.sql<{ oldPath: string; reason: string }[]>`
    SELECT old_path AS "oldPath", reason
    FROM page_url_history
    WHERE page_id = ${pageId}
    ORDER BY id
  `;
}

async function auditLogCount(handle: Db): Promise<number> {
  const [row] = await handle.sql<{ count: string }[]>`
    SELECT count(*) AS count FROM audit_log
  `;
  return Number(row?.count ?? 0);
}

async function deniedSetPatternRowCount(handle: Db): Promise<number> {
  const [row] = await handle.sql<{ count: string }[]>`
    SELECT count(*) AS count FROM audit_log
    WHERE action = 'page.set-url-pattern' AND outcome = 'denied'
  `;
  return Number(row?.count ?? 0);
}

describe('computePageResolvedPath (no database)', () => {
  it('composes locale and path under the default pattern', () => {
    expect(
      computePageResolvedPath({
        pattern: '{locale}/{path}',
        locale: 'en',
        path: 'about-us',
      }),
    ).toBe('en/about-us');
  });

  it('resolves to just the path under a locale-less pattern', () => {
    expect(
      computePageResolvedPath({
        pattern: '{path}',
        locale: 'en',
        path: 'about-us',
      }),
    ).toBe('about-us');
  });
});

describe('read-only operations (shared database, no pattern writes)', () => {
  let environment: PagesTestEnvironment;

  beforeAll(async () => {
    environment = await setUpPagesTestEnvironment();
  });

  afterAll(async () => {
    await tearDownPagesTestEnvironment(environment);
  });

  describe('assertPageAddressAvailable', () => {
    it('throws PageUrlCollisionError naming the existing page when the address is taken', async () => {
      const holderId = await insertRawPage(environment.handle, {
        locale: 'en',
        slug: 'taken',
        path: 'taken',
        title: 'Taken',
        status: 'published',
        resolvedPath: 'en/taken',
      });

      let error: unknown;
      await environment.db.transaction(async (tx) => {
        try {
          await assertPageAddressAvailable(tx, {
            locale: 'en',
            resolvedPath: 'en/taken',
          });
        } catch (caught) {
          error = caught;
        }
      });

      expect(error).toBeInstanceOf(PageUrlCollisionError);
      expect((error as PageUrlCollisionError).existingPageId).toBe(holderId);
    });

    it('excludes excludePageId from the check', async () => {
      const pageId = await insertRawPage(environment.handle, {
        locale: 'en',
        slug: 'self',
        path: 'self',
        title: 'Self',
        status: 'published',
        resolvedPath: 'en/self',
      });

      await expect(
        environment.db.transaction(async (tx) => {
          await assertPageAddressAvailable(tx, {
            locale: 'en',
            resolvedPath: 'en/self',
            excludePageId: pageId,
          });
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('computeUrlPatternChangeImpact', () => {
    it('reports currentPattern/newPattern and no collisions, writing nothing to audit_log', async () => {
      const before = await auditLogCount(environment.handle);

      await insertRawPage(environment.handle, {
        locale: 'en',
        slug: 'preview-only',
        path: 'preview-only',
        title: 'Preview Only',
        status: 'published',
        resolvedPath: 'en/preview-only',
      });

      const impact = await computeUrlPatternChangeImpact(environment.db, {
        newPattern: '{path}',
      });
      expect(impact.currentPattern).toBe('{locale}/{path}');
      expect(impact.newPattern).toBe('{path}');
      expect(impact.changedCount).toBeGreaterThanOrEqual(1);

      const after = await auditLogCount(environment.handle);
      expect(after).toBe(before);
    });

    it('throws PageUrlPatternError for an invalid new pattern', async () => {
      await expect(
        computeUrlPatternChangeImpact(environment.db, {
          newPattern: '/leading-slash',
        }),
      ).rejects.toBeInstanceOf(PageUrlPatternError);
    });

    it('reports a collision when two different-locale pages would resolve to the same address', async () => {
      const enId = await insertRawPage(environment.handle, {
        locale: 'en',
        slug: 'shared-address',
        path: 'shared-address',
        title: 'EN Shared',
        status: 'published',
        resolvedPath: 'en/shared-address',
      });
      const nlId = await insertRawPage(environment.handle, {
        locale: 'nl',
        slug: 'shared-address',
        path: 'shared-address',
        title: 'NL Shared',
        status: 'published',
        resolvedPath: 'nl/shared-address',
      });

      const impact = await computeUrlPatternChangeImpact(environment.db, {
        newPattern: '{path}',
      });
      const collision = impact.collisions.find(
        (c) => c.resolvedPath === 'shared-address',
      );
      expect(collision).toBeDefined();
      expect([...(collision?.pageIds ?? [])].sort()).toEqual(
        [enId, nlId].sort(),
      );
    });
  });
});

describe('setPageUrlPattern: collision refusal', () => {
  let environment: PagesTestEnvironment;

  beforeAll(async () => {
    environment = await setUpPagesTestEnvironment();
  });

  afterAll(async () => {
    await tearDownPagesTestEnvironment(environment);
  });

  it('refuses with PageUrlPatternCollisionError naming both pages; the stored pattern and history are unchanged', async () => {
    const { handle, deps, superadmin } = environment;

    const enId = await insertRawPage(handle, {
      locale: 'en',
      slug: 'about-collide',
      path: 'about-collide',
      title: 'EN About',
      status: 'published',
      resolvedPath: 'en/about-collide',
    });
    const nlId = await insertRawPage(handle, {
      locale: 'nl',
      slug: 'about-collide',
      path: 'about-collide',
      title: 'NL About',
      status: 'published',
      resolvedPath: 'nl/about-collide',
    });

    const error: unknown = await setPageUrlPattern(deps, superadmin, {
      newPattern: '{path}',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PageUrlPatternCollisionError);
    const collisionError = error as PageUrlPatternCollisionError;
    const collision = collisionError.collisions.find(
      (c) => c.resolvedPath === 'about-collide',
    );
    expect(collision).toBeDefined();
    expect([...(collision?.pageIds ?? [])].sort()).toEqual([enId, nlId].sort());

    expect(await getStoredUrlPattern(handle)).toBe('{locale}/{path}');
    expect(await getResolvedPath(handle, enId)).toBe('en/about-collide');
    expect(await getResolvedPath(handle, nlId)).toBe('nl/about-collide');
    expect(await historyRows(handle, enId)).toHaveLength(0);
    expect(await historyRows(handle, nlId)).toHaveLength(0);
  });
});

describe('setPageUrlPattern: successful change', () => {
  let environment: PagesTestEnvironment;

  beforeAll(async () => {
    environment = await setUpPagesTestEnvironment();
  });

  afterAll(async () => {
    await tearDownPagesTestEnvironment(environment);
  });

  it('rewrites every affected published page, records history, leaves unpublished pages untouched', async () => {
    const { handle, deps, superadmin } = environment;

    const changingId = await insertRawPage(handle, {
      locale: 'en',
      slug: 'change-me',
      path: 'change-me',
      title: 'Change Me',
      status: 'published',
      resolvedPath: 'en/change-me',
    });
    const unpublishedId = await insertRawPage(handle, {
      locale: 'en',
      slug: 'drafty',
      path: 'drafty',
      title: 'Drafty',
      status: 'draft',
      resolvedPath: null,
    });

    const result = await setPageUrlPattern(deps, superadmin, {
      newPattern: '{path}',
    });
    expect(result.changedCount).toBeGreaterThanOrEqual(1);
    expect(result.collisions).toHaveLength(0);

    expect(await getResolvedPath(handle, changingId)).toBe('change-me');
    const rows = await historyRows(handle, changingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      oldPath: 'en/change-me',
      reason: 'pattern_changed',
    });

    // Unpublished page: untouched, resolved_path stays null, no history.
    expect(await getResolvedPath(handle, unpublishedId)).toBeNull();
    expect(await historyRows(handle, unpublishedId)).toHaveLength(0);

    expect(await getStoredUrlPattern(handle)).toBe('{path}');
  });

  it('is a no-op (no history, unchanged addresses) when set to the value already stored, but still records one audit row', async () => {
    const { handle, deps, superadmin } = environment;

    const stableId = await insertRawPage(handle, {
      locale: 'en',
      slug: 'stable',
      path: 'stable',
      title: 'Stable',
      status: 'published',
      resolvedPath: 'stable',
    });

    const before = await auditLogCount(handle);
    // The previous test in this describe already moved the stored pattern
    // to "{path}" -- set it to that same value again.
    const result = await setPageUrlPattern(deps, superadmin, {
      newPattern: '{path}',
    });
    const after = await auditLogCount(handle);

    expect(after - before).toBe(1);
    expect(result.changedCount).toBe(0);
    expect(await getResolvedPath(handle, stableId)).toBe('stable');
    expect(await historyRows(handle, stableId)).toHaveLength(0);
  });
});

describe('setPageUrlPattern: recompute inside its own transaction', () => {
  let environment: PagesTestEnvironment;

  beforeAll(async () => {
    environment = await setUpPagesTestEnvironment();
  });

  afterAll(async () => {
    await tearDownPagesTestEnvironment(environment);
  });

  it('includes a page published between an earlier preview and the write', async () => {
    const { handle, db, deps, superadmin } = environment;

    const preExistingId = await insertRawPage(handle, {
      locale: 'en',
      slug: 'pre-existing',
      path: 'pre-existing',
      title: 'Pre Existing',
      status: 'published',
      resolvedPath: 'en/pre-existing',
    });

    // A caller previews the change...
    const preview = await computeUrlPatternChangeImpact(db, {
      newPattern: '{path}',
    });
    expect(preview.collisions).toHaveLength(0);

    // ...then, before the write runs, another page is published -- exactly
    // the race setPageUrlPattern's own in-transaction recompute (there is
    // no caller-supplied "trust this impact" parameter anywhere in this
    // design) is built to survive.
    const racedId = await insertRawPage(handle, {
      locale: 'en',
      slug: 'raced-in',
      path: 'raced-in',
      title: 'Raced In',
      status: 'published',
      resolvedPath: 'en/raced-in',
    });

    const result = await setPageUrlPattern(deps, superadmin, {
      newPattern: '{path}',
    });
    expect(result.changedCount).toBeGreaterThanOrEqual(2);

    expect(await getResolvedPath(handle, preExistingId)).toBe('pre-existing');
    expect(await getResolvedPath(handle, racedId)).toBe('raced-in');
  });

  it('swaps two pages addresses under the new pattern without a unique violation (clear-then-set, T-04-43)', async () => {
    const { handle, deps, superadmin } = environment;

    // A genuine two-way swap: A's stored (old) address is exactly what B
    // is about to become, and vice versa -- `path` and `resolved_path` are
    // independent columns at the raw-SQL level, so this fixture can set
    // them inconsistently on purpose, simulating pages whose addresses
    // were set under a different arrangement previously.
    const swapAId = await insertRawPage(handle, {
      locale: 'en',
      slug: 'swap-a',
      path: 'swap-target-a',
      title: 'Swap A',
      status: 'published',
      resolvedPath: 'en/swap-target-b',
    });
    const swapBId = await insertRawPage(handle, {
      locale: 'en',
      slug: 'swap-b',
      path: 'swap-target-b',
      title: 'Swap B',
      status: 'published',
      resolvedPath: 'en/swap-target-a',
    });

    const result = await setPageUrlPattern(deps, superadmin, {
      newPattern: '{locale}/{path}',
    });
    expect(result.collisions).toHaveLength(0);
    // A's new address (en/swap-target-a) is exactly what B held a moment
    // ago, and vice versa -- this only succeeds because setPageUrlPattern
    // clears every changed row's resolved_path in one statement before
    // setting any new value in a second.
    expect(await getResolvedPath(handle, swapAId)).toBe('en/swap-target-a');
    expect(await getResolvedPath(handle, swapBId)).toBe('en/swap-target-b');
  });
});

describe('setPageUrlPattern: permission denial', () => {
  let environment: PagesTestEnvironment;

  beforeAll(async () => {
    environment = await setUpPagesTestEnvironment();
  });

  afterAll(async () => {
    await tearDownPagesTestEnvironment(environment);
  });

  it('a user without pages:publish gets PermissionDeniedError and a denied audit row', async () => {
    const { handle, deps, pageAuthor } = environment;
    const before = await deniedSetPatternRowCount(handle);

    const error: unknown = await setPageUrlPattern(deps, pageAuthor, {
      newPattern: '{path}',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PermissionDeniedError);

    const after = await deniedSetPatternRowCount(handle);
    expect(after - before).toBe(1);
    // The pattern is unchanged: a denied attempt writes nothing.
    expect(await getStoredUrlPattern(handle)).toBe('{locale}/{path}');
  });
});

describe('setPageUrlPattern: two concurrent changes serialise', () => {
  let environment: PagesTestEnvironment;

  beforeAll(async () => {
    environment = await setUpPagesTestEnvironment();
  });

  afterAll(async () => {
    await tearDownPagesTestEnvironment(environment);
  });

  it('runs two concurrent calls without a lost update: the settings row ends at exactly one of the two patterns', async () => {
    const { handle, deps, superadmin } = environment;

    await insertRawPage(handle, {
      locale: 'en',
      slug: 'race-page',
      path: 'race-page',
      title: 'Race Page',
      status: 'published',
      resolvedPath: 'en/race-page',
    });

    const settled = await Promise.allSettled([
      setPageUrlPattern(deps, superadmin, { newPattern: '{path}' }),
      setPageUrlPattern(deps, superadmin, {
        newPattern: '{locale}/{path}/v2',
      }),
    ]);
    // Both are individually valid, non-colliding patterns against this
    // one-page fixture, so both should succeed -- serialised by the
    // settings row's FOR UPDATE lock rather than racing into a lost
    // update. Whichever ran last determines the final stored value.
    const fulfilledCount = settled.filter(
      (outcome) => outcome.status === 'fulfilled',
    ).length;
    expect(fulfilledCount).toBe(2);

    const finalPattern = await getStoredUrlPattern(handle);
    expect(['{path}', '{locale}/{path}/v2']).toContain(finalPattern);
  });
});
