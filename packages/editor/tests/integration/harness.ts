/**
 * The Postgres harness for the edit entrypoint: a migrated database, a real
 * auth instance with signed-in users (editor, viewer, drafts reader and an
 * unenrolled superadmin), a host config with two blocks that spread the live
 * edit attributes, a capturing document composer and pages in three states.
 *
 * `definePagesConfig` registers blocks process-wide, so `harnessConfig` is
 * created once at module scope (Vitest isolates modules per test file).
 */
import { randomUUID } from 'node:crypto';
import {
  createAuditRecorder,
  createAuth,
  createUserWithRole,
  SUPERADMIN_ROLE_KEY,
  type Auth,
  type AuditActor,
  type AuditRecorder,
  type MailMessage,
  type MailSender,
} from '@plakboek/auth';
import { defineContentConfig } from '@plakboek/content';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import {
  createPage,
  defineBlocks,
  definePagesConfig,
  getPage,
  insertBlock,
  publishPage,
  type PagesDeps,
} from '@plakboek/pages';
import {
  createPermissionResolver,
  defaultRoles,
  defineRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import type {
  BlockComponentProps,
  DocumentInput,
  RenderDocument,
} from '@plakboek/render';
import {
  createComponentMap,
  type EditEntrypoint,
  type EditRequestContext,
} from '@plakboek/render/server';
import { createElement, type ReactElement } from 'react';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const BASE_URL = 'http://localhost:3000';
const SECRET = 'editor-entrypoint-secret-with-at-least-32-characters';
const SESSION_COOKIE = 'better-auth.session_token';
export const PASSWORD = 'correct horse battery staple';
export const SITE_ORIGIN = 'http://site.test';

function SectionBlock({ edit, children }: BlockComponentProps): ReactElement {
  return createElement('section', { ...edit }, children);
}

function HeadingBlock({ edit, props }: BlockComponentProps): ReactElement {
  return createElement('h2', { ...edit }, String(props.text));
}

export const harnessConfig = definePagesConfig({
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
      properties: {},
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
  ]),
  sectionNestingDepth: 2,
  blockDepthCeiling: 12,
});

export const harnessRoles = defineRoles({
  ...defaultRoles,
  viewer: ['pages:read'],
  drafts: ['pages:read', 'pages:read-drafts'],
});

export const components = createComponentMap(harnessConfig.blocks);

/** What the composer saw on each call, and the analytics script it leaves
 * out of every rendering that is not a visitor's. */
export type CapturedDocument = Pick<DocumentInput, 'mode' | 'publicPath'>;

export const composed: CapturedDocument[] = [];

export const ANALYTICS_TAG = '<script src="/analytics.js"></script>';

/** A host document: analytics only for a visitor, like a real host's. */
export const renderDocument: RenderDocument = (input) => {
  composed.push({ mode: input.mode, publicPath: input.publicPath });
  const analytics = input.mode === 'visitor' ? ANALYTICS_TAG : '';
  return `<!DOCTYPE html><html lang="${input.head.lang}"><head><title>${input.head.title}</title></head><body>${input.body}${analytics}</body></html>`;
};

const CLOCK = (): Date => new Date('2026-10-10T09:00:00.000Z');

export type SignedIn = {
  readonly userId: string;
  readonly cookie: string;
};

export type Harness = {
  readonly testDatabase: TestDatabase;
  readonly handle: Db;
  readonly auth: Auth;
  readonly resolver: PermissionResolver;
  readonly recorder: AuditRecorder;
  readonly actor: AuditActor;
  readonly editor: SignedIn;
  readonly viewer: SignedIn;
  readonly drafts: SignedIn;
  readonly superadmin: SignedIn;
  readonly pagesDeps: PagesDeps;
  close(): Promise<void>;
};

function recordingMail(): MailSender & { readonly sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    send(message) {
      sent.push(message);
      return Promise.resolve();
    },
  };
}

function cookieFrom(headers: Headers): string {
  for (const cookie of headers.getSetCookie()) {
    const [pair] = cookie.split(';');
    if (pair?.startsWith(`${SESSION_COOKIE}=`) === true) return pair;
  }
  throw new Error('sign-in returned no session cookie');
}

/** A migrated database, an auth instance and one signed-in user per role. */
export async function createHarness(): Promise<Harness> {
  const testDatabase = await createTestDatabase();
  let handle: Db | undefined;
  try {
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });
    const opened = handle;
    const resolver = createPermissionResolver(harnessRoles);
    const recorder = createAuditRecorder({
      db: opened.db,
      resolver,
      now: CLOCK,
    });
    const auth = createAuth({
      db: opened.db,
      baseURL: BASE_URL,
      secret: SECRET,
      mail: recordingMail(),
      roles: harnessRoles,
    });
    const context = await auth.$context;

    // The first user an installation gets is always the superadmin.
    async function signedIn(roleKey: string, name: string): Promise<SignedIn> {
      const email = `${name.toLowerCase()}@example.com`;
      const created = await createUserWithRole(opened.db, {
        id: randomUUID(),
        email,
        name,
        roleKey,
      });
      await context.internalAdapter.linkAccount({
        userId: created.userId,
        providerId: 'credential',
        accountId: created.userId,
        password: await context.password.hash(PASSWORD),
      });
      const result = await auth.api.signInEmail({
        body: { email, password: PASSWORD },
        returnHeaders: true,
      });
      return { userId: created.userId, cookie: cookieFrom(result.headers) };
    }

    const superadmin = await signedIn(SUPERADMIN_ROLE_KEY, 'Owner');
    const editor = await signedIn('editor', 'Editor');
    const viewer = await signedIn('viewer', 'Viewer');
    const drafts = await signedIn('drafts', 'Drafts');
    const actor: AuditActor = {
      userId: superadmin.userId,
      roleKey: SUPERADMIN_ROLE_KEY,
    };
    const pagesDeps: PagesDeps = {
      db: opened.db,
      recorder,
      resolver,
      config: harnessConfig,
      now: CLOCK,
    };
    return {
      testDatabase,
      handle: opened,
      auth,
      resolver,
      recorder,
      actor,
      editor,
      viewer,
      drafts,
      superadmin,
      pagesDeps,
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

export type SeededPage = {
  readonly pageId: string;
  readonly sectionId: string;
};

/** Creates a page holding one section with one heading. */
export async function createHeadingPage(
  harness: Harness,
  input: { readonly title: string; readonly text: string },
): Promise<SeededPage> {
  const { pagesDeps, actor } = harness;
  const page = await createPage(pagesDeps, actor, {
    locale: 'en',
    title: input.title,
  });
  const owner = {
    ownerType: 'page' as const,
    ownerId: page.id,
    locale: page.locale,
  };
  const section = await insertBlock(pagesDeps, actor, {
    owner,
    blockType: 'section',
    parentBlockId: null,
    basePageVersion: page.version,
  });
  await insertBlock(pagesDeps, actor, {
    owner,
    blockType: 'heading',
    parentBlockId: section.id,
    props: { text: input.text },
    basePageVersion: page.version + 1,
  });
  return { pageId: page.id, sectionId: section.id };
}

/** Publishes a page at its current version. */
export async function publish(harness: Harness, pageId: string): Promise<void> {
  const current = await getPage(harness.pagesDeps.db, pageId);
  await publishPage(harness.pagesDeps, harness.actor, {
    pageId,
    baseVersion: current?.version ?? -1,
  });
}

/** Adds a heading to an existing section, after the page was published. */
export async function addHeading(
  harness: Harness,
  seeded: SeededPage,
  text: string,
): Promise<void> {
  const current = await getPage(harness.pagesDeps.db, seeded.pageId);
  if (current === null) throw new Error('page not found');
  await insertBlock(harness.pagesDeps, harness.actor, {
    owner: {
      ownerType: 'page',
      ownerId: seeded.pageId,
      locale: current.locale,
    },
    blockType: 'heading',
    parentBlockId: seeded.sectionId,
    props: { text },
    basePageVersion: current.version,
  });
}

/** The request the visitor handler would hand an entrypoint: the same path
 * and query, and the location it bounces to without `_edit`. */
export function editRequest(
  pathAndQuery: string,
  headers?: Readonly<Record<string, string>>,
): [Request, EditRequestContext] {
  const url = new URL(`${SITE_ORIGIN}${pathAndQuery}`);
  const kept = [...url.searchParams.entries()].filter(
    ([name]) => name !== '_edit',
  );
  const query = new URLSearchParams(kept).toString();
  const visitorLocation =
    query === '' ? url.pathname : `${url.pathname}?${query}`;
  return [
    new Request(url, { headers: new Headers(headers) }),
    { url, visitorLocation },
  ];
}

export async function callEntrypoint(
  entrypoint: EditEntrypoint,
  pathAndQuery: string,
  headers?: Readonly<Record<string, string>>,
): Promise<Response | null> {
  const [request, context] = editRequest(pathAndQuery, headers);
  return await entrypoint(request, context);
}
