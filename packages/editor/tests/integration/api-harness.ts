/**
 * The Postgres harness for the editor API: a migrated database, a real auth
 * instance with signed-in users (editor, a second editor, a viewer, an editor
 * role without delete, and an enrolled superadmin), a host config that uses
 * the render package's column cell, a controllable clock, and helpers that
 * create pages through the engine and build API requests.
 *
 * `definePagesConfig` registers blocks process-wide, so `apiConfig` is
 * created once at module scope and a test file imports either this harness or
 * `harness.ts`, never both.
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
  constrainBlock,
  createPage,
  defineBlocks,
  definePagesConfig,
  insertBlock,
  type PagesDeps,
} from '@plakboek/pages';
import {
  createPermissionResolver,
  defaultRoles,
  defineRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import {
  ColumnBlock,
  Columns,
  type BlockComponentProps,
} from '@plakboek/render';
import { createComponentMap } from '@plakboek/render/server';
import { sql } from 'drizzle-orm';
import { createElement, type ReactElement } from 'react';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const BASE_URL = 'http://localhost:3000';
const SECRET = 'editor-api-secret-with-at-least-32-characters-long';
const SESSION_COOKIE = 'better-auth.session_token';
export const PASSWORD = 'correct horse battery staple';
export const SITE_ORIGIN = 'http://site.test';

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function SectionBlock({
  edit,
  layout,
  children,
}: BlockComponentProps): ReactElement {
  return createElement(
    'section',
    { ...edit },
    createElement(Columns, { layout, children }),
  );
}

function HeadingBlock({ edit, props }: BlockComponentProps): ReactElement {
  return createElement('h2', { ...edit }, text(props.text));
}

function TextBlock({ edit, props }: BlockComponentProps): ReactElement {
  return createElement('p', { ...edit }, text(props.body));
}

function QuoteBlock({ edit, props }: BlockComponentProps): ReactElement {
  return createElement('blockquote', { ...edit }, text(props.body));
}

export const apiConfig = definePagesConfig({
  content: defineContentConfig({
    locales: ['en', 'nl'],
    defaultLocale: 'en',
    timezone: 'Europe/Brussels',
  }),
  blocks: defineBlocks([
    {
      key: 'column',
      kind: 'column',
      editor: { label: 'Column' },
      schemaVersion: 1,
      component: ColumnBlock,
      properties: {},
    },
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
      editor: { label: 'Heading', category: 'Text' },
      schemaVersion: 1,
      component: HeadingBlock,
      properties: {
        text: {
          fieldType: 'short_text',
          label: 'Text',
          required: true,
          options: { maxLength: 120 },
        },
        anchor: {
          fieldType: 'short_text',
          label: 'Anchor',
          options: { maxLength: 40 },
        },
      },
    },
    {
      key: 'text',
      editor: { label: 'Text', category: 'Text' },
      schemaVersion: 1,
      component: TextBlock,
      properties: {
        body: {
          fieldType: 'short_text',
          label: 'Body',
          options: { maxLength: 400 },
        },
      },
    },
    {
      key: 'quote',
      editor: { label: 'Quote' },
      schemaVersion: 1,
      component: QuoteBlock,
      layout: { fill: true },
      properties: {
        body: {
          fieldType: 'short_text',
          label: 'Quote',
          options: { maxLength: 400 },
        },
      },
    },
  ]),
  constraints: [constrainBlock('heading', { anchor: 'hidden' })],
  sectionNestingDepth: 2,
  blockDepthCeiling: 12,
});

/** The editor role minus deleting pages. */
export const LIMITED_ROLE_KEY = 'limited';

export const apiRoles = defineRoles({
  ...defaultRoles,
  viewer: ['pages:read'],
  [LIMITED_ROLE_KEY]: ['pages:read', 'pages:read-drafts', 'pages:edit'],
});

export const components = createComponentMap(apiConfig.blocks);

const START = new Date('2026-10-10T09:00:00.000Z');

/** The time the engine sees; tests move it to age a lock. */
export type TestClock = {
  now(): Date;
  advance(milliseconds: number): void;
  reset(): void;
};

export type SignedIn = {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly cookie: string;
};

export type ApiHarness = {
  readonly testDatabase: TestDatabase;
  readonly handle: Db;
  readonly auth: Auth;
  readonly resolver: PermissionResolver;
  readonly recorder: AuditRecorder;
  readonly actor: AuditActor;
  readonly clock: TestClock;
  readonly editor: SignedIn;
  readonly editor2: SignedIn;
  readonly viewer: SignedIn;
  readonly limited: SignedIn;
  readonly superadmin: SignedIn;
  readonly pagesDeps: PagesDeps;
  close(): Promise<void>;
};

function recordingMail(): MailSender {
  return {
    send(_message: MailMessage) {
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
export async function createApiHarness(): Promise<ApiHarness> {
  const testDatabase = await createTestDatabase();
  let handle: Db | undefined;
  try {
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });
    const opened = handle;
    const resolver = createPermissionResolver(apiRoles);

    let current = START;
    const clock: TestClock = {
      now: () => current,
      advance(milliseconds) {
        current = new Date(current.getTime() + milliseconds);
      },
      reset() {
        current = START;
      },
    };

    const recorder = createAuditRecorder({
      db: opened.db,
      resolver,
      now: () => clock.now(),
    });
    const auth = createAuth({
      db: opened.db,
      baseURL: BASE_URL,
      secret: SECRET,
      mail: recordingMail(),
      roles: apiRoles,
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
      return {
        userId: created.userId,
        name,
        email,
        cookie: cookieFrom(result.headers),
      };
    }

    const superadmin = await signedIn(SUPERADMIN_ROLE_KEY, 'Owner');
    // A superadmin must have a second factor before it may use the API.
    await opened.db.execute(
      sql`UPDATE "user" SET two_factor_enabled = true WHERE id = ${superadmin.userId}`,
    );
    const editor = await signedIn('editor', 'Editor');
    const editor2 = await signedIn('editor', 'Editor2');
    const viewer = await signedIn('viewer', 'Viewer');
    const limited = await signedIn(LIMITED_ROLE_KEY, 'Limited');
    const actor: AuditActor = {
      userId: superadmin.userId,
      roleKey: SUPERADMIN_ROLE_KEY,
    };
    const pagesDeps: PagesDeps = {
      db: opened.db,
      recorder,
      resolver,
      config: apiConfig,
      now: () => clock.now(),
    };
    return {
      testDatabase,
      handle: opened,
      auth,
      resolver,
      recorder,
      actor,
      clock,
      editor,
      editor2,
      viewer,
      limited,
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
  readonly columnId: string | null;
  readonly headingId: string;
};

/** Creates a page holding section > column > heading. */
export async function createColumnPage(
  harness: ApiHarness,
  input: { readonly title: string; readonly text: string | null },
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
  let version = page.version;
  const section = await insertBlock(pagesDeps, actor, {
    owner,
    blockType: 'section',
    parentBlockId: null,
    basePageVersion: version,
  });
  version += 1;
  const column = await insertBlock(pagesDeps, actor, {
    owner,
    blockType: 'column',
    parentBlockId: section.id,
    basePageVersion: version,
  });
  version += 1;
  const heading = await insertBlock(pagesDeps, actor, {
    owner,
    blockType: 'heading',
    parentBlockId: column.id,
    props: input.text === null ? {} : { text: input.text },
    basePageVersion: version,
  });
  return {
    pageId: page.id,
    sectionId: section.id,
    columnId: column.id,
    headingId: heading.id,
  };
}

/**
 * Creates a page in the shape that predates columns: section > heading. The
 * engine refuses to write that shape now, so it is made by moving the heading
 * out of its column with SQL and deleting the column.
 */
export async function createFlatPage(
  harness: ApiHarness,
  input: { readonly title: string; readonly text: string },
): Promise<SeededPage> {
  const seeded = await createColumnPage(harness, input);
  const { db } = harness.handle;
  await db.execute(
    sql`UPDATE page_blocks SET parent_block_id = ${seeded.sectionId}, depth = 1 WHERE id = ${seeded.headingId}`,
  );
  await db.execute(sql`DELETE FROM page_blocks WHERE id = ${seeded.columnId}`);
  return { ...seeded, columnId: null };
}

export type ApiRequestOptions = {
  readonly user?: SignedIn;
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  /** The Origin header; `null` sends none. Defaults to the site's own. */
  readonly origin?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
};

/** A request to the API as a signed-in user, from the site's own origin. */
export function apiRequest(
  path: string,
  options: ApiRequestOptions = {},
): Request {
  const method = options.method ?? 'GET';
  const headers = new Headers(options.headers);
  if (options.user !== undefined) headers.set('cookie', options.user.cookie);
  const origin = options.origin === undefined ? SITE_ORIGIN : options.origin;
  if (origin !== null && method === 'POST') headers.set('origin', origin);
  if (method === 'POST' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Request(`${SITE_ORIGIN}${path}`, {
    method,
    headers,
    ...(method === 'POST'
      ? {
          body:
            options.body === undefined ? '{}' : JSON.stringify(options.body),
        }
      : {}),
  });
}
