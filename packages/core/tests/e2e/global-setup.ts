/**
 * Playwright global setup: builds the adversarial e2e host with the real
 * `react-router build`, creates and migrates a throwaway database, seeds
 * users and pages through the engine packages, and starts the real Hono
 * server against the build. Returns its own teardown.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { SUPERADMIN_ROLE_KEY, createUserWithRole } from '@plakboek/auth';
import { runMigrations } from '@plakboek/db';
import {
  createPage,
  getPage,
  insertBlock,
  publishPage,
  readBlockTree,
  upgradeAllSectionColumns,
} from '@plakboek/pages';
import { Client } from 'pg';
import { bootstrapInstallation } from '../../src/runtime/bootstrap.ts';
import { closeAllDbs } from '../../src/runtime/db.ts';
import { readRuntimeEnv } from '../../src/runtime/env.ts';
import { createRuntime, type Runtime } from '../../src/runtime/runtime.ts';
import { createServer } from '../../src/server.ts';
import type { SeedBlock } from '../../src/types.ts';
import { buildHost, linkCoreInto } from '../integration/fixture-host.ts';
import { createTestDatabase } from '../integration/test-database.ts';
import {
  E2E_CLIENT_DIR,
  E2E_HOST_DIR,
  E2E_SERVER_ENTRY,
  type E2eUsers,
} from './helpers/host.ts';

const ENV_KEYS = ['DATABASE_URL', 'PLAKBOEK_URL', 'PLAKBOEK_SECRET'] as const;

const SUPERADMIN = {
  name: 'Owner',
  email: 'owner@example.com',
  password: 'correct horse battery staple',
};
const EDITOR = {
  name: 'Edith Editor',
  email: 'editor@example.com',
  password: 'an editor passphrase 2026',
};
const VIEWER = {
  name: 'Vera Viewer',
  email: 'viewer@example.com',
  password: 'a viewer passphrase 2026',
};

/** Fails with the redacting message the integration setup uses. */
async function requireReachablePostgres(): Promise<void> {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString || connectionString.length === 0) {
    throw new Error(
      'TEST_DATABASE_URL is not set: run `docker compose up -d --wait postgres` and export the value from .env.example',
    );
  }
  const { hostname, port, password } = new URL(connectionString);
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const redactedReason = password
      ? reason.split(password).join('<redacted>')
      : reason;
    throw new Error(
      `Could not reach Postgres at ${hostname}:${port || '5432'} using TEST_DATABASE_URL -- run \`docker compose up -d --wait postgres\` first (${redactedReason})`,
      { cause: error },
    );
  } finally {
    await client.end();
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

type Actor = { readonly userId: string; readonly roleKey: string };

type PageSpec = {
  readonly title: string;
  readonly slug: string;
  readonly blocks: readonly SeedBlock[];
};

function section(...children: readonly SeedBlock[]): SeedBlock {
  return {
    type: 'section',
    props: { variant: 'plain' },
    children: [{ type: 'column', children }],
  };
}

function heading(text: string): SeedBlock {
  return { type: 'heading', props: { text } };
}

function paragraph(text: string): SeedBlock {
  return { type: 'text', props: { text } };
}

/** Creates a page and its block tree; returns the page and its owner. */
async function createContentPage(
  runtime: Runtime,
  actor: Actor,
  spec: PageSpec,
) {
  const deps = runtime.pages;
  const page = await createPage(deps, actor, {
    locale: runtime.config.content.defaultLocale,
    title: spec.title,
    slug: spec.slug,
  });
  const owner = {
    ownerType: 'page' as const,
    ownerId: page.id,
    locale: page.locale,
  };

  // Every structural write bumps the page version: re-read it each time.
  async function currentVersion(): Promise<number> {
    const current = await getPage(deps.db, page.id);
    if (current === null || current === undefined) {
      throw new Error(`The e2e page ${spec.slug} disappeared during setup`);
    }
    return current.version;
  }

  /** Inserts the nodes in order and returns their ids at this level. */
  async function insertNodes(
    nodes: readonly SeedBlock[],
    parentBlockId: string | null,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const node of nodes) {
      const block = await insertBlock(deps, actor, {
        owner,
        blockType: node.type,
        parentBlockId,
        ...(node.props === undefined ? {} : { props: node.props }),
        basePageVersion: await currentVersion(),
      });
      ids.push(block.id);
      await insertNodes(node.children ?? [], block.id);
    }
    return ids;
  }

  const rootIds = await insertNodes(spec.blocks, null);
  return { page, owner, rootIds, currentVersion };
}

async function publish(
  runtime: Runtime,
  actor: Actor,
  created: Awaited<ReturnType<typeof createContentPage>>,
): Promise<void> {
  await publishPage(runtime.pages, actor, {
    pageId: created.page.id,
    baseVersion: await created.currentVersion(),
  });
}

/**
 * Adds a block of a type the host never declares to a page's working tree, as
 * a sibling right after `siblingId`, by direct SQL: the engine refuses to
 * insert an unknown type, but a tree can hold one when a host drops a block
 * type later. Owner, locale, parent and depth are copied from the sibling and
 * the block takes the next free position in that parent. The read path
 * degrades it, and the edit render shows its placeholder.
 */
async function insertUnknownTypeBlock(
  connectionString: string,
  siblingId: string,
  blockType: string,
): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query(
      `INSERT INTO page_blocks (
         owner_type, owner_id, locale, parent_block_id, block_type, props,
         schema_version, depth, sort_order, version, created_at, updated_at
       )
       SELECT
         sibling.owner_type, sibling.owner_id, sibling.locale,
         sibling.parent_block_id, $2, '{}'::jsonb, 1, sibling.depth,
         COALESCE((
           SELECT max(other.sort_order) + 1
           FROM page_blocks other
           WHERE other.owner_type = sibling.owner_type
             AND other.owner_id = sibling.owner_id
             AND other.locale = sibling.locale
             AND other.parent_block_id IS NOT DISTINCT FROM sibling.parent_block_id
         ), 0),
         1, now(), now()
       FROM page_blocks sibling
       WHERE sibling.id = $1`,
      [siblingId, blockType],
    );
    if (result.rowCount !== 1) {
      throw new Error(
        `The e2e setup found no block ${siblingId} to place ${blockType} beside`,
      );
    }
  } finally {
    await client.end();
  }
}

async function seedPages(
  runtime: Runtime,
  actor: Actor,
  connectionString: string,
): Promise<void> {
  // `about` is published, then changed so the working tree differs from the
  // published snapshot.
  const about = await createContentPage(runtime, actor, {
    title: 'About',
    slug: 'about',
    blocks: [
      section(heading('About us'), paragraph('The published about page.')),
    ],
  });
  await publish(runtime, actor, about);
  const columnId = (await readBlockTree(runtime.db.db, about.owner))[0]
    ?.children[0]?.id;
  if (columnId === undefined) {
    throw new Error('The e2e about page has no column to extend');
  }
  const unpublished = await insertBlock(runtime.pages, actor, {
    owner: about.owner,
    blockType: 'heading',
    parentBlockId: columnId,
    props: { text: 'Unpublished change' },
    basePageVersion: await about.currentVersion(),
  });
  // A block whose type the host no longer declares, for the overlay's
  // "(unavailable)" label.
  await insertUnknownTypeBlock(
    connectionString,
    unpublished.id,
    'retired-widget',
  );

  const clean = await createContentPage(runtime, actor, {
    title: 'Clean',
    slug: 'clean',
    blocks: [
      section(heading('Clean page'), paragraph('Served without hostile CSS.')),
    ],
  });
  await publish(runtime, actor, clean);

  // Published, but its edit render fails (the e2e host throws for it).
  const broken = await createContentPage(runtime, actor, {
    title: 'Broken',
    slug: 'broken',
    blocks: [section(heading('Broken page'))],
  });
  await publish(runtime, actor, broken);

  // Never published: it exists only in the working tree.
  await createContentPage(runtime, actor, {
    title: 'Draft only',
    slug: 'draft-only',
    blocks: [section(heading('Draft only'), paragraph('Never published.'))],
  });
}

async function createUser(
  runtime: Runtime,
  account: { name: string; email: string; password: string },
  roleKey: string,
): Promise<void> {
  const context = await runtime.auth.$context;
  const passwordHash = await context.password.hash(account.password);
  await createUserWithRole(runtime.db.db, {
    id: randomUUID(),
    email: account.email,
    name: account.name,
    roleKey,
    passwordHash,
  });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  await requireReachablePostgres();

  linkCoreInto(E2E_HOST_DIR);
  buildHost(E2E_HOST_DIR);

  const database = await createTestDatabase();
  await runMigrations({ connectionString: database.connectionString });

  // The port comes first: better-auth checks request origins against
  // PLAKBOEK_URL, which therefore has to name the port the server will use.
  const port = await freePort();
  const environment = {
    DATABASE_URL: database.connectionString,
    PLAKBOEK_URL: `http://127.0.0.1:${port}`,
    PLAKBOEK_SECRET: randomBytes(36).toString('base64url').slice(0, 48),
  };
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    process.env[key] = environment[key];
  }

  let server: Awaited<ReturnType<ReturnType<typeof createServer>['start']>>;
  try {
    const { default: config } = await import('../e2e-host/plakboek.config.ts');
    const runtime = createRuntime({ config }, readRuntimeEnv(environment));

    const bootstrapped = await bootstrapInstallation(runtime, {
      name: SUPERADMIN.name,
      email: SUPERADMIN.email,
      password: SUPERADMIN.password,
    });
    await createUser(runtime, EDITOR, 'editor');
    await createUser(runtime, VIEWER, 'viewer');
    await seedPages(
      runtime,
      { userId: bootstrapped.userId, roleKey: SUPERADMIN_ROLE_KEY },
      database.connectionString,
    );
    // Seeded trees may predate columns. Upgrading them now, as the server
    // would in the background, keeps the first edit page a spec opens from
    // being reloaded by the editor once the upgrade lands.
    while ((await upgradeAllSectionColumns(runtime.pages)).upgraded > 0) {
      // another batch
    }

    server = await createServer({
      buildPath: E2E_SERVER_ENTRY,
      clientDir: E2E_CLIENT_DIR,
      port,
      host: '127.0.0.1',
    }).start();
  } catch (error) {
    await closeAllDbs();
    await database.drop();
    throw error;
  }

  const users: E2eUsers = {
    superadmin: { email: SUPERADMIN.email, password: SUPERADMIN.password },
    editor: { email: EDITOR.email, password: EDITOR.password },
    viewer: { email: VIEWER.email, password: VIEWER.password },
  };
  process.env.E2E_BASE_URL = environment.PLAKBOEK_URL;
  process.env.E2E_USERS = JSON.stringify(users);

  return async () => {
    await server.close();
    await closeAllDbs();
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await database.drop();
  };
}
