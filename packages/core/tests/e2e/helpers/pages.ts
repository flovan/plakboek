/**
 * Pages the specs create for themselves, so a spec that changes a page's tree
 * never touches one another spec reads. They go through the same engine path
 * global setup used (`createPage` and `insertBlock`), against the same
 * throwaway database: the worker inherits the environment global setup
 * exported.
 */
import { randomBytes } from 'node:crypto';
import { createPage, getPage, insertBlock, publishPage } from '@plakboek/pages';
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

/** A section holding `children`, in the shape global setup seeds. */
export function section(...children: readonly FactoryBlock[]): FactoryBlock {
  return { type: 'section', props: { variant: 'plain' }, children };
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
}): Promise<EditablePage> {
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
    await closeAllDbs();
  }
}
