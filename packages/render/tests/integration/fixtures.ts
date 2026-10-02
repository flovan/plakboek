/**
 * Shared fixtures for the render integration suite: one host config with
 * three fixture blocks (two with render counters, one that always throws), a
 * real-Postgres fixture with a superadmin and a read-only viewer, and the
 * publish and request helpers every file builds on.
 *
 * `fixtureConfig` is created at module scope, which runs once per test file
 * (Vitest isolates modules per file). Never call `definePagesConfig` from a
 * helper that can run twice: the block registry is process-wide and a second
 * registration is a boot error.
 */
import { randomUUID } from 'node:crypto';
import {
  createAuditRecorder,
  createUserWithRole,
  SUPERADMIN_ROLE_KEY,
  type AfterCommitFailureHook,
  type AuditActor,
  type AuditRecorder,
} from '@plakboek/auth';
import type { CacheInvalidator } from '@plakboek/cache';
import { defineContentConfig } from '@plakboek/content';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import {
  createPermissionResolver,
  defaultRoles,
  defineRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import {
  createPage,
  defineBlocks,
  definePagesConfig,
  getPage,
  insertBlock,
  publishPage,
  type PagesDeps,
} from '@plakboek/pages';
import { createElement } from 'react';
import type { BlockComponent } from '../../src/index.js';
import type { VisitorHandler } from '../../src/server.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

/** How often each fixture block's component ran. */
export const renderCounts = { heading: 0 };

export function resetRenderCounts(): void {
  renderCounts.heading = 0;
}

const SectionBlock: BlockComponent = ({ edit, children }) =>
  createElement('section', { ...edit }, children);

const HeadingBlock: BlockComponent = ({ edit, props }) => {
  renderCounts.heading += 1;
  return createElement('h2', { ...edit.field('text') }, String(props.text));
};

const BoomBlock: BlockComponent = () => {
  throw new Error('boom block failed to render');
};

export const fixtureConfig = definePagesConfig({
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
      component: SectionBlock,
      properties: {
        width: {
          fieldType: 'select',
          label: 'Width',
          options: {
            choices: [
              { value: 'full', labels: { en: 'Full', nl: 'Volledig' } },
              {
                value: 'contained',
                labels: { en: 'Contained', nl: 'Ingesloten' },
              },
            ],
          },
        },
      },
    },
    {
      key: 'heading',
      editor: { label: 'Heading' },
      schemaVersion: 1,
      component: HeadingBlock,
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
      key: 'boom',
      editor: { label: 'Boom' },
      schemaVersion: 1,
      component: BoomBlock,
      properties: {},
    },
  ]),
  sectionNestingDepth: 2,
  blockDepthCeiling: 12,
});

export const fixtureRoles = defineRoles({
  ...defaultRoles,
  viewer: ['pages:read'],
});

const CLOCK = (): Date => new Date('2026-09-25T09:00:00.000Z');

export type Fixture = {
  readonly testDatabase: TestDatabase;
  readonly handle: Db;
  readonly resolver: PermissionResolver;
  readonly recorder: AuditRecorder;
  readonly superadmin: AuditActor;
  readonly viewer: AuditActor;
  close(): Promise<void>;
};

export type CreateFixtureOptions = {
  readonly onAfterCommitFailed?: AfterCommitFailureHook;
};

/** A fresh, migrated database with a superadmin and a read-only viewer. */
export async function createFixture(
  options: CreateFixtureOptions = {},
): Promise<Fixture> {
  const testDatabase = await createTestDatabase();
  let handle: Db | undefined;
  try {
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });
    const resolver = createPermissionResolver(fixtureRoles);
    const recorder = createAuditRecorder({
      db: handle.db,
      resolver,
      now: CLOCK,
      ...(options.onAfterCommitFailed === undefined
        ? {}
        : { onAfterCommitFailed: options.onAfterCommitFailed }),
    });
    const owner = await createUserWithRole(handle.db, {
      id: randomUUID(),
      email: 'owner@example.com',
      name: 'Owner',
      roleKey: SUPERADMIN_ROLE_KEY,
    });
    const reader = await createUserWithRole(handle.db, {
      id: randomUUID(),
      email: 'viewer@example.com',
      name: 'Viewer',
      roleKey: 'viewer',
    });
    const opened = handle;
    return {
      testDatabase,
      handle: opened,
      resolver,
      recorder,
      superadmin: { userId: owner.userId, roleKey: owner.roleKey },
      viewer: { userId: reader.userId, roleKey: reader.roleKey },
      async close(): Promise<void> {
        await opened.close();
        await testDatabase.drop();
      },
    };
  } catch (error) {
    await handle?.close();
    await testDatabase.drop();
    throw error;
  }
}

/** The page engine's dependency bag over a fixture. */
export function pagesDepsFor(
  fixture: Fixture,
  invalidator?: CacheInvalidator,
): PagesDeps {
  return {
    db: fixture.handle.db,
    recorder: fixture.recorder,
    resolver: fixture.resolver,
    config: fixtureConfig,
    now: CLOCK,
    ...(invalidator === undefined ? {} : { invalidator }),
  };
}

export type PublishHeadingPageInput = {
  readonly locale: string;
  readonly title: string;
  readonly text: string;
  readonly parentPageId?: string | null;
  readonly slug?: string;
};

export type PublishedHeadingPage = {
  readonly pageId: string;
  readonly sectionId: string;
  readonly headingId: string;
  /** The page version after the publish. */
  readonly pageVersion: number;
  /** The heading block's version. */
  readonly headingVersion: number;
};

/** Creates a page with a section holding one heading, then publishes it. */
export async function publishHeadingPage(
  deps: PagesDeps,
  actor: AuditActor,
  input: PublishHeadingPageInput,
): Promise<PublishedHeadingPage> {
  const page = await createPage(deps, actor, {
    locale: input.locale,
    title: input.title,
    ...(input.slug === undefined ? {} : { slug: input.slug }),
    ...(input.parentPageId === undefined
      ? {}
      : { parentPageId: input.parentPageId }),
  });
  const owner = {
    ownerType: 'page' as const,
    ownerId: page.id,
    locale: page.locale,
  };
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
    props: { text: input.text },
    basePageVersion: page.version + 1,
  });
  const beforePublish = await getPage(deps.db, page.id);
  await publishPage(deps, actor, {
    pageId: page.id,
    baseVersion: beforePublish?.version ?? -1,
  });
  const afterPublish = await getPage(deps.db, page.id);
  return {
    pageId: page.id,
    sectionId: section.id,
    headingId: heading.id,
    pageVersion: afterPublish?.version ?? -1,
    headingVersion: heading.version,
  };
}

/** Sends a request through a visitor handler. */
export async function visit(
  handler: VisitorHandler,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return await handler(new Request(`http://visitor.test${path}`, init));
}
