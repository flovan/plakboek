/**
 * `publishPage`/`buildPageSnapshot`/`DegradedBlockPublishError`/
 * `readPublishedSnapshot` (04-09-PLAN.md Task 1), proven end to end
 * against real Postgres: a clean publish, a degraded-block refusal that
 * leaves the previous snapshot serving, an invalid-upcast-but-not-
 * validating refusal, per-block publish-kind revisions sharing one batch,
 * a stale-version refusal, and permission gating.
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
  DegradedBlockPublishError,
  publishPage,
  readPublishedSnapshot,
} from '../../src/publish.js';
import { defineBlocks } from '../../src/registry.js';
import { insertBlock } from '../../src/tree.js';
import { createTestDatabase } from './test-database.js';

const roles = defineRoles({ ...defaultRoles, viewer: ['pages:read'] });

describe('publishPage/buildPageSnapshot/readPublishedSnapshot (D-30, D-31, D-33)', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let db: AuditDatabase;
  let deps: PagesDeps;
  let actor: AuditActor;
  let viewer: AuditActor;
  let clockTime = new Date('2026-09-25T12:00:00.000Z');
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
        // schemaVersion 3, no upcasters declared at all -- upcasting a
        // stored version below current is unreachable through a
        // `defineBlocks`-valid config (D-10), so this type exists purely
        // to raw-insert a row whose upcast SUCCEEDS (identity, current
        // version) but whose props fail `validateBlockProps` -- the
        // "upcasts but does not validate" refusal path.
        {
          key: 'strict',
          editor: { label: 'Strict' },
          schemaVersion: 1,
          properties: {
            label: {
              fieldType: 'short_text',
              label: 'Label',
              required: true,
              options: { maxLength: 40 },
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
    deps = { db, recorder, resolver, config, now: clock };
  });

  afterAll(async () => {
    await handle.close();
    await testDatabase.drop();
  });

  it('publishes a clean tree: one row, is_draft false, a manifest naming every block, a non-empty hash, and moves the live publication pointer', async () => {
    clockTime = new Date('2026-09-25T12:00:00.000Z');
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Home',
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
    const heading = await insertBlock(deps, actor, {
      owner,
      blockType: 'heading',
      parentBlockId: section.id,
      props: { text: 'Welcome' },
      basePageVersion: 2,
    });

    const pageBeforePublish = await getPage(db, page.id);
    const publication = await publishPage(deps, actor, {
      pageId: page.id,
      baseVersion: pageBeforePublish?.version ?? 0,
    });

    expect(publication.isDraft).toBe(false);
    expect(publication.manifestHash.length).toBeGreaterThan(0);
    expect(Object.keys(publication.revisionManifest).sort()).toEqual(
      [section.id, heading.id].sort(),
    );
    expect(publication.snapshot).toEqual({
      blocks: [
        {
          id: section.id,
          blockType: 'section',
          schemaVersion: 1,
          props: { width: 'full' },
          children: [
            {
              id: heading.id,
              blockType: 'heading',
              schemaVersion: 1,
              props: { text: 'Welcome' },
              children: [],
            },
          ],
        },
      ],
      // The page's title and head SEO set are frozen with the tree.
      title: 'Home',
      seo: {
        title: null,
        description: null,
        imageAssetId: null,
        canonicalUrl: null,
        noindex: false,
        nofollow: false,
      },
    });

    const pageAfterPublish = await getPage(db, page.id);
    expect(pageAfterPublish?.status).toBe('published');
    expect(pageAfterPublish?.livePublicationId).toBe(publication.id);
    expect(pageAfterPublish?.publishedAt).not.toBeNull();
    expect(pageAfterPublish?.firstPublishedAt).not.toBeNull();

    const readBack = await readPublishedSnapshot(db, { pageId: page.id });
    expect(readBack?.id).toBe(publication.id);
    expect(readBack?.snapshot).toEqual(publication.snapshot);
  });

  it('leaves first_published_at unchanged and advances published_at on a second publish', async () => {
    clockTime = new Date('2026-09-25T12:10:00.000Z');
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Republish',
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
    await insertBlock(deps, actor, {
      owner,
      blockType: 'heading',
      parentBlockId: section.id,
      props: { text: 'One' },
      basePageVersion: 2,
    });

    const pageAfterInsert = await getPage(db, page.id);
    await publishPage(deps, actor, {
      pageId: page.id,
      baseVersion: pageAfterInsert?.version ?? 0,
    });
    const pageAfterFirstPublish = await getPage(db, page.id);
    const firstPublishedAt = pageAfterFirstPublish?.firstPublishedAt;
    expect(firstPublishedAt).not.toBeNull();

    clockTime = new Date('2026-09-25T12:20:00.000Z');
    await publishPage(deps, actor, {
      pageId: page.id,
      baseVersion: pageAfterFirstPublish?.version ?? 0,
    });
    const pageAfterSecondPublish = await getPage(db, page.id);

    expect(pageAfterSecondPublish?.firstPublishedAt?.toISOString()).toBe(
      firstPublishedAt?.toISOString(),
    );
    expect(pageAfterSecondPublish?.publishedAt?.toISOString()).toBe(
      clockTime.toISOString(),
    );
  });

  it('refuses DegradedBlockPublishError for a degraded block, naming every offending block, writing nothing and leaving the previous snapshot serving', async () => {
    clockTime = new Date('2026-09-25T12:30:00.000Z');
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Degraded page',
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
    const pageBeforeFirstPublish = await getPage(db, page.id);
    const firstPublication = await publishPage(deps, actor, {
      pageId: page.id,
      baseVersion: pageBeforeFirstPublish?.version ?? 0,
    });

    // Two raw-inserted degraded rows: an unregistered block type, and a
    // registered `heading` whose stored `schema_version` (2) is above the
    // registry's current `schemaVersion` (1) -- reachable regardless of
    // upcaster completeness (D-10), unlike a genuine upcaster gap.
    const [unknownRow] = await handle.sql<{ id: string }[]>`
      INSERT INTO page_blocks (
        owner_type, owner_id, locale, parent_block_id, block_type, props,
        schema_version, depth, sort_order, version, created_at, updated_at
      ) VALUES (
        'page', ${page.id}, 'en', NULL, 'noLongerRegistered', '{}'::jsonb,
        1, 0, 5000, 1, ${clockTime.toISOString()}, ${clockTime.toISOString()}
      ) RETURNING id
    `;
    const [aboveCurrentRow] = await handle.sql<{ id: string }[]>`
      INSERT INTO page_blocks (
        owner_type, owner_id, locale, parent_block_id, block_type, props,
        schema_version, depth, sort_order, version, created_at, updated_at
      ) VALUES (
        'page', ${page.id}, 'en', NULL, 'heading', '{"text": "x"}'::jsonb,
        2, 0, 6000, 1, ${clockTime.toISOString()}, ${clockTime.toISOString()}
      ) RETURNING id
    `;

    if (unknownRow === undefined || aboveCurrentRow === undefined) {
      throw new Error('raw insert returned no row');
    }
    const unknownId: string = unknownRow.id;
    const aboveCurrentId: string = aboveCurrentRow.id;

    const pageBeforeRefusedPublish = await getPage(db, page.id);
    const error: unknown = await publishPage(deps, actor, {
      pageId: page.id,
      baseVersion: pageBeforeRefusedPublish?.version ?? 0,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DegradedBlockPublishError);
    const offendingIds = (error as DegradedBlockPublishError).blocks.map(
      (block) => block.blockId,
    );
    expect(offendingIds.sort((a, b) => a.localeCompare(b))).toEqual(
      [unknownId, aboveCurrentId].sort((a, b) => a.localeCompare(b)),
    );
    expect(
      (error as DegradedBlockPublishError).blocks.find(
        (block) => block.blockId === unknownId,
      )?.reason,
    ).toBe('unknown-block-type');
    expect(
      (error as DegradedBlockPublishError).blocks.find(
        (block) => block.blockId === aboveCurrentId,
      )?.reason,
    ).toBe('above-current');

    const [publicationCountRow] = await handle.sql<
      { count: string }[]
    >`SELECT count(*) AS count FROM page_publications WHERE page_id = ${page.id}`;
    expect(Number(publicationCountRow?.count)).toBe(1);

    const pageAfterRefusal = await getPage(db, page.id);
    expect(pageAfterRefusal?.livePublicationId).toBe(firstPublication.id);
    expect(pageAfterRefusal?.version).toBe(pageBeforeRefusedPublish?.version);

    const stillServing = await readPublishedSnapshot(db, { pageId: page.id });
    expect(stillServing?.id).toBe(firstPublication.id);
    expect(stillServing?.snapshot).toEqual(firstPublication.snapshot);
  });

  it('refuses DegradedBlockPublishError for a block that upcasts cleanly but fails current validation, writing nothing', async () => {
    clockTime = new Date('2026-09-25T12:40:00.000Z');
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Invalid props page',
    });
    // Raw-inserted at the CURRENT schema version (1) -- upcastOnRead
    // resolves this as identity (never degraded), so only
    // `validateBlockProps` inside `buildPageSnapshot` can catch the
    // missing required `label`.
    const [strictRow] = await handle.sql<{ id: string }[]>`
      INSERT INTO page_blocks (
        owner_type, owner_id, locale, parent_block_id, block_type, props,
        schema_version, depth, sort_order, version, created_at, updated_at
      ) VALUES (
        'page', ${page.id}, 'en', NULL, 'strict', '{}'::jsonb,
        1, 0, 1000, 1, ${clockTime.toISOString()}, ${clockTime.toISOString()}
      ) RETURNING id
    `;

    const pageBeforePublish = await getPage(db, page.id);
    const error: unknown = await publishPage(deps, actor, {
      pageId: page.id,
      baseVersion: pageBeforePublish?.version ?? 0,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DegradedBlockPublishError);
    expect((error as DegradedBlockPublishError).blocks).toEqual([
      {
        blockId: strictRow?.id,
        blockType: 'strict',
        reason: 'invalid-props',
        detail: expect.stringContaining('"label"'),
      },
    ]);

    const [publicationCountRow] = await handle.sql<
      { count: string }[]
    >`SELECT count(*) AS count FROM page_publications WHERE page_id = ${page.id}`;
    expect(Number(publicationCountRow?.count)).toBe(0);
  });

  it('records one publish-kind revision per block sharing one revision_batch_id, matching the manifest values', async () => {
    clockTime = new Date('2026-09-25T12:50:00.000Z');
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Revision batch page',
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
    const heading = await insertBlock(deps, actor, {
      owner,
      blockType: 'heading',
      parentBlockId: section.id,
      props: { text: 'Nested' },
      basePageVersion: 2,
    });

    const pageBeforePublish = await getPage(db, page.id);
    const publication = await publishPage(deps, actor, {
      pageId: page.id,
      baseVersion: pageBeforePublish?.version ?? 0,
    });

    const revisionRows = await handle.sql<
      { id: string; blockId: string; kind: string; revisionBatchId: string }[]
    >`
      SELECT id, block_id AS "blockId", kind, revision_batch_id AS "revisionBatchId"
      FROM block_revisions
      WHERE kind = 'publish' AND owner_id = ${page.id}
    `;
    expect(revisionRows).toHaveLength(2);
    const batchIds = new Set(revisionRows.map((row) => row.revisionBatchId));
    expect(batchIds.size).toBe(1);
    const revisionIdsByBlock = new Map(
      revisionRows.map((row) => [row.blockId, row.id]),
    );
    expect(revisionIdsByBlock.get(section.id)).toBe(
      publication.revisionManifest[section.id],
    );
    expect(revisionIdsByBlock.get(heading.id)).toBe(
      publication.revisionManifest[heading.id],
    );
  });

  it('refuses StalePageVersionError from a stale baseVersion and writes nothing', async () => {
    clockTime = new Date('2026-09-25T13:00:00.000Z');
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Stale publish page',
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

    const error: unknown = await publishPage(deps, actor, {
      pageId: page.id,
      baseVersion: page.version, // stale: insertBlock already bumped it to 2
    }).catch((caught: unknown) => caught);

    const { StalePageVersionError } = await import('../../src/tree.js');
    expect(error).toBeInstanceOf(StalePageVersionError);

    const [publicationCountRow] = await handle.sql<
      { count: string }[]
    >`SELECT count(*) AS count FROM page_publications WHERE page_id = ${page.id}`;
    expect(Number(publicationCountRow?.count)).toBe(0);
  });

  it('refuses PermissionDeniedError for an actor without pages:publish, with a denied audit row', async () => {
    clockTime = new Date('2026-09-25T13:10:00.000Z');
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Denied publish page',
    });

    const error: unknown = await publishPage(deps, viewer, {
      pageId: page.id,
      baseVersion: page.version,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PermissionDeniedError);

    const deniedRows = await handle.sql<{ outcome: string }[]>`
      SELECT outcome FROM audit_log
      WHERE action = 'page.publish' AND entity_id = ${page.id} AND outcome = 'denied'
    `;
    expect(deniedRows).toHaveLength(1);
  });
});
