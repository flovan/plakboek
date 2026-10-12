/**
 * `resolveEditablePage` (Phase 7 D-20), proven against real Postgres: a public
 * path resolves to a page's live working tree -- unpublished changes and
 * draft-only pages included, trashed pages excluded -- with the visitor
 * resolver's redirect and not-found semantics, and without reading a
 * publication.
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
  defineRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  definePagesConfig,
  type PagesDeps,
  type PagesHooks,
} from '../../src/config.js';
import {
  resolveEditablePage,
  type EditablePageResolution,
  type ResolveEditablePageInput,
} from '../../src/editable.js';
import { schedulePage, trashPage } from '../../src/lifecycle.js';
import { createPage, getPage } from '../../src/pages.js';
import { publishPage } from '../../src/publish.js';
import { defineBlocks } from '../../src/registry.js';
import { insertBlock } from '../../src/tree.js';
import type { BlockNode } from '../../src/types.js';
import type { DegradedBlockEvent } from '../../src/versioning.js';
import { createTestDatabase } from './test-database.js';

const roles = defineRoles({ ...defaultRoles });

function edit(publicPath: string): ResolveEditablePageInput {
  return {
    publicPath,
    locales: ['en', 'nl'],
    defaultLocale: 'en',
    homeSlug: 'home',
  };
}

type PageResolution = Extract<EditablePageResolution, { kind: 'page' }>;

function asPage(result: EditablePageResolution): PageResolution {
  if (result.kind !== 'page') {
    throw new Error(`expected a page resolution, got ${result.kind}`);
  }
  return result;
}

describe('editable page resolution (D-20)', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let db: AuditDatabase;
  let deps: PagesDeps;
  let actor: AuditActor;
  const clock = (): Date => new Date('2026-10-10T12:00:00.000Z');

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
        timezone: 'Europe/Brussels',
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
      ]),
      sectionNestingDepth: 2,
      blockDepthCeiling: 8,
    });

    const owner = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'owner@example.com',
      name: 'Owner',
      roleKey: SUPERADMIN_ROLE_KEY,
    });
    actor = { userId: owner.userId, roleKey: owner.roleKey };
    deps = { db, recorder, resolver, config, now: clock };
  });

  afterAll(async () => {
    await handle.close();
    await testDatabase.drop();
  });

  /** Adds a section holding one heading (a page's direct children must be
   * sections) and returns the heading's id. */
  async function addHeading(
    pageId: string,
    locale: string,
    text: string,
  ): Promise<string> {
    const owner = { ownerType: 'page' as const, ownerId: pageId, locale };
    const before = await getPage(db, pageId);
    const section = await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: null,
      props: { width: 'full' },
      basePageVersion: before?.version ?? 0,
    });
    const afterSection = await getPage(db, pageId);
    const heading = await insertBlock(deps, actor, {
      owner,
      blockType: 'heading',
      parentBlockId: section.id,
      props: { text },
      basePageVersion: afterSection?.version ?? 0,
    });
    return heading.id;
  }

  function textOf(node: BlockNode): readonly unknown[] {
    const props: unknown = node.props;
    const own =
      node.blockType === 'heading' &&
      typeof props === 'object' &&
      props !== null
        ? [Reflect.get(props, 'text')]
        : [];
    return [...own, ...node.children.flatMap(textOf)];
  }

  function headingTexts(result: PageResolution): readonly unknown[] {
    return result.blocks.flatMap(textOf);
  }

  it('resolves the live tree of a published page, including a block added after publishing', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'About us',
      slug: 'about-us',
    });
    await addHeading(page.id, 'en', 'First');
    const afterFirst = await getPage(db, page.id);
    const publication = await publishPage(deps, actor, {
      pageId: page.id,
      baseVersion: afterFirst?.version ?? 0,
    });
    await addHeading(page.id, 'en', 'Added after publishing');

    const result = asPage(await resolveEditablePage(db, edit('/about-us')));

    expect(result.publicPath).toBe('/about-us');
    expect(headingTexts(result)).toEqual(['First', 'Added after publishing']);
    expect(
      (publication.snapshot as { blocks: readonly unknown[] }).blocks,
    ).toHaveLength(1);
    expect(result.blocks).toHaveLength(2);
    expect(result.page).toMatchObject({
      id: page.id,
      locale: 'en',
      path: 'about-us',
      title: 'About us',
      status: 'published',
      livePublicationId: publication.id,
    });
    expect(result.page.seo).toEqual({
      title: null,
      description: null,
      imageAssetId: null,
      canonicalUrl: null,
      noindex: false,
      nofollow: false,
    });
  });

  it('resolves a never-published draft page and reports its status and version', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Draft only',
      slug: 'draft-only',
    });
    await addHeading(page.id, 'en', 'Not live yet');
    const current = await getPage(db, page.id);

    const result = asPage(await resolveEditablePage(db, edit('/draft-only')));

    expect(result.page.status).toBe('draft');
    expect(result.page.livePublicationId).toBeNull();
    expect(result.page.version).toBe(current?.version);
    expect(headingTexts(result)).toEqual(['Not live yet']);
  });

  it('resolves a scheduled page', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Coming soon',
      slug: 'coming-soon',
    });
    await addHeading(page.id, 'en', 'Soon');
    const current = await getPage(db, page.id);
    await schedulePage(deps, actor, {
      pageId: page.id,
      baseVersion: current?.version ?? 0,
      scheduledAt: new Date('2027-01-01T09:00:00.000Z'),
    });

    const result = asPage(await resolveEditablePage(db, edit('/coming-soon')));

    expect(result.page.status).toBe('scheduled');
    expect(headingTexts(result)).toEqual(['Soon']);
  });

  it('serves the page at the locale root through the home slug', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Home',
      slug: 'home',
    });

    const result = asPage(await resolveEditablePage(db, edit('/')));

    expect(result.publicPath).toBe('/');
    expect(result.page.id).toBe(page.id);
    expect(result.blocks).toEqual([]);
  });

  it('reads a non-default locale under its prefix', async () => {
    const page = await createPage(deps, actor, {
      locale: 'nl',
      title: 'Over ons',
      slug: 'over-ons',
    });
    await addHeading(page.id, 'nl', 'Welkom');

    const result = asPage(await resolveEditablePage(db, edit('/nl/over-ons')));

    expect(result.page.locale).toBe('nl');
    expect(headingTexts(result)).toEqual(['Welkom']);
  });

  it('does not resolve a trashed page', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Gone',
      slug: 'gone',
    });
    const current = await getPage(db, page.id);
    await trashPage(deps, actor, {
      pageId: page.id,
      baseVersion: current?.version ?? 0,
    });

    expect(await resolveEditablePage(db, edit('/gone'))).toEqual({
      kind: 'not-found',
    });
  });

  it('redirects the explicit home spelling and the prefixed default locale, and misses an unknown path', async () => {
    expect(await resolveEditablePage(db, edit('/home'))).toEqual({
      kind: 'redirect',
      location: '/',
    });
    expect(await resolveEditablePage(db, edit('/en/about-us'))).toEqual({
      kind: 'redirect',
      location: '/about-us',
    });
    expect(await resolveEditablePage(db, edit('/no-such-page'))).toEqual({
      kind: 'not-found',
    });
    expect(await resolveEditablePage(db, edit('/about-us/'))).toEqual({
      kind: 'not-found',
    });
  });

  it('reports an unparsable stored pattern as invalid-pattern instead of throwing', async () => {
    await handle.sql`UPDATE page_engine_settings SET url_pattern = '{path}.html' WHERE id = 1`;
    try {
      const result = await resolveEditablePage(db, edit('/about-us'));
      expect(result.kind).toBe('invalid-pattern');
    } finally {
      await handle.sql`UPDATE page_engine_settings SET url_pattern = '{locale}/{path}' WHERE id = 1`;
    }
  });

  it('returns a block of a type the config no longer declares as a degraded node and reports it once', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Legacy',
      slug: 'legacy',
    });
    await handle.sql`
      INSERT INTO page_blocks (
        owner_type, owner_id, locale, parent_block_id, block_type, props,
        schema_version, depth, sort_order, version, created_at, updated_at
      ) VALUES (
        'page', ${page.id}, 'en', NULL, 'noLongerRegistered', '{}'::jsonb,
        1, 0, 5000, 1, ${clock().toISOString()}, ${clock().toISOString()}
      )
    `;
    const events: DegradedBlockEvent[] = [];
    const hooks: PagesHooks = {
      onDegradedBlock: (event) => events.push(event),
    };

    const result = asPage(
      await resolveEditablePage(db, edit('/legacy'), hooks),
    );

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({
      blockType: 'noLongerRegistered',
      degraded: true,
      degradedReason: 'unknown-block-type',
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe('unknown-block-type');
  });
});
