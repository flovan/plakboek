/**
 * Pages the specs create for themselves, so a spec that changes a page's tree
 * never touches one another spec reads. They go through the same engine path
 * global setup used (`createPage` and `insertBlock`), against the same
 * throwaway database: the worker inherits the environment global setup
 * exported.
 */
import { randomBytes } from 'node:crypto';
import { getTextTheme, registerTextTheme } from '@plakboek/content';
import {
  resolveTextTheme,
  type TextThemeInput,
} from '@plakboek/content/rich-text';
import {
  createPage,
  getPage,
  insertBlock,
  publishPage,
  renamePage,
  trashPage,
} from '@plakboek/pages';
import { sql } from 'drizzle-orm';
import { closeAllDbs } from '../../../src/runtime/db.ts';
import { readRuntimeEnv } from '../../../src/runtime/env.ts';
import { createRuntime } from '../../../src/runtime/runtime.ts';
import { e2eUsers } from './host.ts';

/** One block of a factory page; `type` is a block key. */
export type FactoryBlock = {
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly children?: readonly FactoryBlock[];
};

/** A section holding `children` in one column, in the shape global setup seeds. */
export function section(...children: readonly FactoryBlock[]): FactoryBlock {
  return {
    type: 'section',
    props: { variant: 'plain' },
    children: [{ type: 'column', children }],
  };
}

export function heading(text: string): FactoryBlock {
  return { type: 'heading', props: { text } };
}

export function paragraph(text: string): FactoryBlock {
  return { type: 'text', props: { text } };
}

export type EditablePage = {
  readonly pageId: string;
  readonly slug: string;
  /** The visitor path of the page, `/<slug>`. */
  readonly path: string;
};

/**
 * Creates a page with a random slug and the given block tree, as the
 * superadmin, in the default locale. The page stays a draft unless `publish`
 * is true.
 */
export async function createEditablePage(input: {
  readonly title?: string;
  readonly blocks: readonly FactoryBlock[];
  readonly publish?: boolean;
  /**
   * A wider text theme to hold the blocks' text to while the page is made, in
   * this worker process only, so a spec can store a document the e2e host's
   * own theme (which the running site enforces) no longer allows. The host
   * theme is restored before this returns.
   */
  readonly textTheme?: TextThemeInput;
}): Promise<EditablePage> {
  const { default: config } = await import('../../e2e-host/plakboek.config.ts');
  const hostTheme = getTextTheme();
  if (input.textTheme !== undefined) {
    registerTextTheme(resolveTextTheme(input.textTheme));
  }
  const runtime = createRuntime({ config }, readRuntimeEnv(process.env));
  try {
    const rows = await runtime.db.db.execute<{ id: string; role: string }>(
      sql`SELECT id, role_key AS role FROM "user" WHERE email = ${e2eUsers().superadmin.email}`,
    );
    const owner = rows[0];
    if (owner === undefined) {
      throw new Error('The e2e superadmin account does not exist');
    }
    const actor = { userId: owner.id, roleKey: owner.role };

    const deps = runtime.pages;
    const slug = `e2e-${randomBytes(6).toString('hex')}`;
    const page = await createPage(deps, actor, {
      locale: runtime.config.content.defaultLocale,
      title: input.title ?? 'Factory page',
      slug,
    });
    const blockOwner = {
      ownerType: 'page' as const,
      ownerId: page.id,
      locale: page.locale,
    };

    // Every structural write bumps the page version: re-read it each time.
    async function currentVersion(): Promise<number> {
      const current = await getPage(deps.db, page.id);
      if (current === null || current === undefined) {
        throw new Error(`The e2e page ${slug} disappeared during setup`);
      }
      return current.version;
    }

    async function insertNodes(
      nodes: readonly FactoryBlock[],
      parentBlockId: string | null,
    ): Promise<void> {
      for (const node of nodes) {
        const block = await insertBlock(deps, actor, {
          owner: blockOwner,
          blockType: node.type,
          parentBlockId,
          ...(node.props === undefined ? {} : { props: node.props }),
          basePageVersion: await currentVersion(),
        });
        await insertNodes(node.children ?? [], block.id);
      }
    }

    await insertNodes(input.blocks, null);
    if (input.publish === true) {
      await publishPage(deps, actor, {
        pageId: page.id,
        baseVersion: await currentVersion(),
      });
    }
    return { pageId: page.id, slug, path: `/${slug}` };
  } finally {
    registerTextTheme(hostTheme);
    await closeAllDbs();
  }
}

/**
 * Releases every page lock. A spec that ends by closing its browser never
 * lets the page go (no unload runs), so the lock it took on a shared page
 * stays until it expires; the next spec to edit that page would find it held
 * by someone else. Specs that edit a shared page start from here.
 */
export async function releaseAllPageLocks(): Promise<void> {
  const { default: config } = await import('../../e2e-host/plakboek.config.ts');
  const runtime = createRuntime({ config }, readRuntimeEnv(process.env));
  try {
    await runtime.db.db.execute(
      sql`UPDATE pages SET locked_by = NULL, locked_at = NULL WHERE locked_by IS NOT NULL`,
    );
  } finally {
    await closeAllDbs();
  }
}

/**
 * The saved props of the first block of `blockType` on a page, read straight
 * from the database: what a reload would show, without going through a page.
 */
export async function readBlockProps(
  pageId: string,
  blockType: string,
): Promise<Record<string, unknown>> {
  const { default: config } = await import('../../e2e-host/plakboek.config.ts');
  const runtime = createRuntime({ config }, readRuntimeEnv(process.env));
  try {
    const rows = await runtime.db.db.execute<{
      props: Record<string, unknown>;
    }>(
      sql`SELECT props FROM page_blocks WHERE owner_id = ${pageId} AND block_type = ${blockType} ORDER BY depth, sort_order LIMIT 1`,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`The page ${pageId} has no ${blockType} block`);
    }
    return row.props;
  } finally {
    await closeAllDbs();
  }
}

/**
 * Runs `action` as the superadmin against the same throwaway database, with
 * the page as it is now, so a spec can change a page behind the editor's back
 * the way another editor would.
 */
async function asSuperadmin(
  pageId: string,
  action: (
    deps: ReturnType<typeof createRuntime>['pages'],
    actor: { readonly userId: string; readonly roleKey: string },
    version: number,
  ) => Promise<unknown>,
): Promise<void> {
  const { default: config } = await import('../../e2e-host/plakboek.config.ts');
  const runtime = createRuntime({ config }, readRuntimeEnv(process.env));
  try {
    const rows = await runtime.db.db.execute<{ id: string; role: string }>(
      sql`SELECT id, role_key AS role FROM "user" WHERE email = ${e2eUsers().superadmin.email}`,
    );
    const owner = rows[0];
    if (owner === undefined) {
      throw new Error('The e2e superadmin account does not exist');
    }
    const page = await getPage(runtime.pages.db, pageId);
    if (page === null) throw new Error(`The page ${pageId} does not exist`);
    await action(
      runtime.pages,
      { userId: owner.id, roleKey: owner.role },
      page.version,
    );
  } finally {
    await closeAllDbs();
  }
}

/** Gives a page a new slug (and so a new public path), as another editor would. */
export async function renamePageSlug(
  pageId: string,
  slug: string,
): Promise<void> {
  await asSuperadmin(pageId, async (deps, actor, baseVersion) => {
    await renamePage(deps, actor, { pageId, baseVersion, slug });
  });
}

/** Moves a page to the trash, so a link to it no longer has a page to point at. */
export async function trashPageById(pageId: string): Promise<void> {
  await asSuperadmin(pageId, async (deps, actor, baseVersion) => {
    await trashPage(deps, actor, { pageId, baseVersion });
  });
}
