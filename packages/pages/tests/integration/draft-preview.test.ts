/**
 * `createDraftSnapshot`/`readLatestDraftSnapshot` (04-09-PLAN.md Task 2),
 * proven end to end against real Postgres: the byte-identity proof that a
 * draft and a publish come out of one shared builder, `pages.version`/
 * `live_publication_id` untouched by a draft, the degraded refusal, and
 * permission gating.
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
import { createPage, getPage } from '../../src/pages.js';
import {
  createDraftSnapshot,
  DegradedBlockPublishError,
  publishPage,
  readLatestDraftSnapshot,
} from '../../src/publish.js';
import { defineBlocks } from '../../src/registry.js';
import { insertBlock } from '../../src/tree.js';
import { createTestDatabase } from './test-database.js';

const roles = defineRoles({
  ...defaultRoles,
  viewer: ['pages:read'],
  'editor-no-drafts': ['pages:create', 'pages:edit'],
});

describe('createDraftSnapshot/readLatestDraftSnapshot (D-32)', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let db: AuditDatabase;
  let deps: PagesDeps;
  let actor: AuditActor;
  let viewer: AuditActor;
  let noDraftsActor: AuditActor;
  let clockTime = new Date('2026-09-25T14:00:00.000Z');
  const clock = (): Date => clockTime;

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
        {
          key: 'section',
          kind: 'section',
          editor: { label: 'Section' },
          schemaVersion: 1,
          properties: {
            width: {
              fieldType: 'select',
              label: 'Width',
              options: {
                choices: [
                  { value: 'full', labels: { en: 'Full' } },
                  { value: 'contained', labels: { en: 'Contained' } },
                ],
              },
            },
          },
        },
        {
          key: 'heading',
          editor: { label: 'Heading' },
          schemaVersion: 1,
          properties: {
            text: {
              fieldType: 'short_text',
              label: 'Text',
              required: true,
              options: { maxLength: 120 },
            },
          },
        },
        {
          key: 'card',
          editor: { label: 'Card' },
          schemaVersion: 1,
          properties: {
            title: {
              fieldType: 'short_text',
              label: 'Title',
              required: true,
              options: { maxLength: 80 },
            },
          },
        },
      ]),
      sectionNestingDepth: 2,
      blockDepthCeiling: 8,
    });

    const superadminUser = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'owner@example.com',
      name: 'Owner',
      roleKey: SUPERADMIN_ROLE_KEY,
    });
    actor = { userId: superadminUser.userId, roleKey: superadminUser.roleKey };
    const viewerUser = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'viewer@example.com',
      name: 'Viewer',
      roleKey: 'viewer',
    });
    viewer = { userId: viewerUser.userId, roleKey: viewerUser.roleKey };
    const noDraftsUser = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'no-drafts@example.com',
      name: 'No Drafts',
      roleKey: 'editor-no-drafts',
    });
    noDraftsActor = {
      userId: noDraftsUser.userId,
      roleKey: noDraftsUser.roleKey,
    };
    deps = { db, recorder, resolver, config, now: clock };
  });

  afterAll(async () => {
    await handle.close();
    await testDatabase.drop();
  });

  it('creates a draft row with is_draft true, a manifest and a hash, leaving live_publication_id/status/version untouched', async () => {
    clockTime = new Date('2026-09-25T14:00:00.000Z');
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Draft page',
    });
    const owner = {
      ownerType: 'page' as const,
      ownerId: page.id,
      locale: 'en',
    };
    await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: null,
      props: { width: 'full' },
      basePageVersion: page.version,
    });
    const pageBeforeDraft = await getPage(db, page.id);

    const draft = await createDraftSnapshot(deps, actor, { pageId: page.id });

    expect(draft.isDraft).toBe(true);
    expect(draft.manifestHash.length).toBeGreaterThan(0);
    expect(Object.keys(draft.revisionManifest)).toHaveLength(1);

    const pageAfterDraft = await getPage(db, page.id);
    expect(pageAfterDraft?.livePublicationId).toBe(
      pageBeforeDraft?.livePublicationId ?? null,
    );
    expect(pageAfterDraft?.status).toBe(pageBeforeDraft?.status);
    expect(pageAfterDraft?.version).toBe(pageBeforeDraft?.version);
    expect(pageAfterDraft?.publishedAt).toBeNull();
  });

  it('produces byte-identical snapshot JSONB to a publish of the same unchanged tree, sharing block ids but not revision ids', async () => {
    clockTime = new Date('2026-09-25T14:10:00.000Z');
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Byte identity page',
    });
    const owner = {
      ownerType: 'page' as const,
      ownerId: page.id,
      locale: 'en',
    };
    const section = await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: null,
      props: { width: 'contained' },
      basePageVersion: page.version,
    });
    await insertBlock(deps, actor, {
      owner,
      blockType: 'heading',
      parentBlockId: section.id,
      props: { text: 'Byte for byte' },
      basePageVersion: 2,
    });
    await insertBlock(deps, actor, {
      owner,
      blockType: 'card',
      parentBlockId: section.id,
      props: { title: 'Nested card' },
      basePageVersion: 3,
    });

    const draft = await createDraftSnapshot(deps, actor, { pageId: page.id });

    const pageAfterDraft = await getPage(db, page.id);
    const publication = await publishPage(deps, actor, {
      pageId: page.id,
      baseVersion: pageAfterDraft?.version ?? 0,
    });

    // The load-bearing assertion: a direct raw-text comparison of the two
    // stored `snapshot` columns, via two SEPARATE queries (one per row),
    // not a deep-equal on parsed objects -- a structurally-equal-but-
    // differently-serialised JSONB value would pass a deep-equal check
    // while still failing the actual byte-identity guarantee a cache key
    // over the raw column depends on.
    const [draftRow] = await handle.sql<{ snapshotText: string }[]>`
      SELECT snapshot::text AS "snapshotText" FROM page_publications WHERE id = ${draft.id}
    `;
    const [publishRow] = await handle.sql<{ snapshotText: string }[]>`
      SELECT snapshot::text AS "snapshotText" FROM page_publications WHERE id = ${publication.id}
    `;
    expect(draftRow?.snapshotText).toBeDefined();
    expect(publishRow?.snapshotText).toBeDefined();
    expect(draftRow?.snapshotText).toBe(publishRow?.snapshotText);

    // Same block ids in both manifests, but different revision ids: each
    // call records its own `'publish'`-kind revisions.
    expect(Object.keys(draft.revisionManifest).sort()).toEqual(
      Object.keys(publication.revisionManifest).sort(),
    );
    for (const blockId of Object.keys(draft.revisionManifest)) {
      expect(draft.revisionManifest[blockId]).not.toBe(
        publication.revisionManifest[blockId],
      );
    }
  });

  it('refuses DegradedBlockPublishError for a degraded block, writing nothing', async () => {
    clockTime = new Date('2026-09-25T14:20:00.000Z');
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Degraded draft page',
    });
    const [unknownRow] = await handle.sql<{ id: string }[]>`
      INSERT INTO page_blocks (
        owner_type, owner_id, locale, parent_block_id, block_type, props,
        schema_version, depth, sort_order, version, created_at, updated_at
      ) VALUES (
        'page', ${page.id}, 'en', NULL, 'noLongerRegistered', '{}'::jsonb,
        1, 0, 1000, 1, ${clockTime.toISOString()}, ${clockTime.toISOString()}
      ) RETURNING id
    `;
    expect(unknownRow).toBeDefined();

    const error: unknown = await createDraftSnapshot(deps, actor, {
      pageId: page.id,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DegradedBlockPublishError);

    const [publicationCountRow] = await handle.sql<
      { count: string }[]
    >`SELECT count(*) AS count FROM page_publications WHERE page_id = ${page.id}`;
    expect(Number(publicationCountRow?.count)).toBe(0);
  });

  it('records publish-kind revisions for a draft too, so its manifest-referenced revisions are never pruned', async () => {
    clockTime = new Date('2026-09-25T14:30:00.000Z');
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Draft revision kind page',
    });
    const owner = {
      ownerType: 'page' as const,
      ownerId: page.id,
      locale: 'en',
    };
    const section = await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: null,
      props: { width: 'full' },
      basePageVersion: page.version,
    });

    const draft = await createDraftSnapshot(deps, actor, { pageId: page.id });
    const revisionId = draft.revisionManifest[section.id];
    expect(revisionId).toBeDefined();

    const revisionRows = await handle.sql<{ kind: string }[]>`
      SELECT kind FROM block_revisions WHERE id = ${revisionId ?? ''}
    `;
    expect(revisionRows).toHaveLength(1);
    expect(revisionRows[0]?.kind).toBe('publish');
  });

  it('readLatestDraftSnapshot returns the newest draft row and deletes neither of two successive drafts', async () => {
    clockTime = new Date('2026-09-25T14:40:00.000Z');
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Latest draft page',
    });
    const owner = {
      ownerType: 'page' as const,
      ownerId: page.id,
      locale: 'en',
    };
    await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: null,
      props: { width: 'full' },
      basePageVersion: page.version,
    });

    const nothingYet = await readLatestDraftSnapshot(db, { pageId: page.id });
    expect(nothingYet).toBeNull();

    const firstDraft = await createDraftSnapshot(deps, actor, {
      pageId: page.id,
    });
    clockTime = new Date('2026-09-25T14:41:00.000Z');
    const secondDraft = await createDraftSnapshot(deps, actor, {
      pageId: page.id,
    });
    expect(secondDraft.id).not.toBe(firstDraft.id);

    const latest = await readLatestDraftSnapshot(db, { pageId: page.id });
    expect(latest?.id).toBe(secondDraft.id);

    const [draftCountRow] = await handle.sql<
      { count: string }[]
    >`SELECT count(*) AS count FROM page_publications WHERE page_id = ${page.id} AND is_draft = true`;
    expect(Number(draftCountRow?.count)).toBe(2);
  });

  it('a draft for one locale returns only that locale tree, never a sibling locale', async () => {
    clockTime = new Date('2026-09-25T14:50:00.000Z');
    const enPage = await createPage(deps, actor, {
      locale: 'en',
      title: 'Locale scoping page',
    });
    const nlPage = await createPage(deps, actor, {
      locale: 'nl',
      title: 'Localescoping pagina',
    });
    const enSection = await insertBlock(deps, actor, {
      owner: { ownerType: 'page', ownerId: enPage.id, locale: 'en' },
      blockType: 'section',
      parentBlockId: null,
      props: { width: 'full' },
      basePageVersion: enPage.version,
    });
    await insertBlock(deps, actor, {
      owner: { ownerType: 'page', ownerId: nlPage.id, locale: 'nl' },
      blockType: 'section',
      parentBlockId: null,
      props: { width: 'contained' },
      basePageVersion: nlPage.version,
    });

    const enDraft = await createDraftSnapshot(deps, actor, {
      pageId: enPage.id,
    });

    expect(enDraft.snapshot.blocks).toHaveLength(1);
    expect(enDraft.snapshot.blocks[0]?.id).toBe(enSection.id);
    expect(enDraft.snapshot.blocks[0]?.props).toEqual({ width: 'full' });
  });

  it('refuses PermissionDeniedError for an actor without pages:read-drafts, with a denied audit row', async () => {
    clockTime = new Date('2026-09-25T15:00:00.000Z');
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Denied draft page',
    });

    const error: unknown = await createDraftSnapshot(deps, noDraftsActor, {
      pageId: page.id,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PermissionDeniedError);

    const deniedRows = await handle.sql<{ outcome: string }[]>`
      SELECT outcome FROM audit_log
      WHERE action = 'page.draft-snapshot' AND entity_id = ${page.id} AND outcome = 'denied'
    `;
    expect(deniedRows).toHaveLength(1);
  });

  it('a viewer with only pages:read is also refused (never read-drafts by default)', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Viewer denied draft page',
    });

    const error: unknown = await createDraftSnapshot(deps, viewer, {
      pageId: page.id,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PermissionDeniedError);
  });
});
