/**
 * The editor API's page-level routes: opening a page for editing, reading its
 * tree and keeping its edit lock.
 *
 * Opening is where the lock is taken (the shell request itself never writes):
 * the page is found from the live working tree, brought into the column shape
 * when it predates columns, the lock is taken when locking is on and free (or
 * already the caller's), and everything the client needs to start comes back
 * in one answer. A lock held by someone else does not fail the open; it is
 * reported as lock state `other` and nothing is taken.
 *
 * A lock view only ever names the holder by display name and last activity.
 * The engine's closed `PageLockView` shape is what is converted here, so no
 * email, role or user id can reach another editor through this file.
 */
import type { AuditActor } from '@plakboek/auth';
import {
  acquirePageLock,
  BLOCK_EDIT_MAX_NODES,
  BLOCK_EDIT_MAX_OPS,
  getPage,
  PAGE_EDIT_LOCK_HEARTBEAT_SECONDS,
  PAGE_EDIT_LOCK_TTL_SECONDS,
  PageLockedError,
  PageLockingDisabledError,
  readBlockTree,
  readPageLockView,
  releasePageLock,
  renewPageLock,
  resolveEditablePage,
  takeOverPageLock,
  upgradeSectionColumns,
  type BlockNode,
  type PageLockView,
  type PageRecord,
} from '@plakboek/pages';
import { normalizeVisitorPath, type BlockMeta } from '@plakboek/render/server';
import type {
  CatalogueEntry,
  EditorSession,
  LockResponse,
  LockView,
  TreeResponse,
} from '../../api-types.js';
import type { EditorIdentity } from '../identity.js';
import { toModelNodes } from '../model.js';
import type { EditorApiDeps } from './handler.js';
import { ApiHttpError } from './http.js';

/** Everything a route needs about this request and this API instance. */
export type ApiContext = {
  readonly deps: EditorApiDeps;
  readonly catalogue: readonly CatalogueEntry[];
  /** Label and kind per block type, for rendering fragments. */
  readonly blockMeta: ReadonlyMap<string, BlockMeta>;
  readonly identity: EditorIdentity;
  readonly actor: AuditActor;
};

/** The engine's lock view with its dates as ISO strings. */
export function toLockView(view: PageLockView): LockView {
  return {
    enabled: view.enabled,
    state: view.state,
    holder:
      view.holder === null
        ? null
        : {
            name: view.holder.name,
            lastActiveAt: view.holder.lastActiveAt.toISOString(),
          },
    canTakeOver: view.canTakeOver,
    expiresAt: view.expiresAt === null ? null : view.expiresAt.toISOString(),
  };
}

/** The lock view of a page for the caller. */
export async function lockViewOf(
  context: ApiContext,
  pageId: string,
): Promise<LockView> {
  return toLockView(
    await readPageLockView(context.deps.pages, context.actor, { pageId }),
  );
}

export function notFound(): ApiHttpError {
  return new ApiHttpError(404, 'not-found');
}

/**
 * Opens the page at a visitor path for editing. Throws `ApiHttpError` 404
 * when no editable page is there; engine errors pass through to the caller's
 * error mapping.
 */
export async function openPage(
  context: ApiContext,
  path: string,
): Promise<EditorSession> {
  const { deps, catalogue, actor, identity } = context;
  const { config } = deps.pages;

  const normalized = normalizeVisitorPath(path);
  // A path that is not already canonical is the client pointing at the wrong
  // address, not something to follow.
  if (normalized.kind !== 'ok') throw notFound();

  const resolution = await resolveEditablePage(
    deps.pages.db,
    {
      publicPath: normalized.path,
      locales: config.content.locales,
      defaultLocale: config.content.defaultLocale,
      homeSlug: deps.homeSlug,
    },
    deps.pages.hooks,
  );
  if (resolution.kind === 'invalid-pattern') {
    // oxlint-disable-next-line no-console -- reports a broken stored URL pattern once per request; the error name only
    console.error('[@plakboek/editor] api open failed', resolution.error.name);
    throw notFound();
  }
  if (resolution.kind !== 'page' || resolution.publicPath !== normalized.path) {
    throw notFound();
  }
  const { id: pageId, locale } = resolution.page;

  // Bring a tree that predates columns into the column shape before it is
  // read, so the client only ever sees one shape.
  const upgrade = await upgradeSectionColumns(deps.pages, { pageId });
  const page = await getPage(deps.pages.db, pageId);
  if (page === null) throw notFound();
  // The version is read before the tree: a write that slips in between only
  // leaves the client with an older base version, which the next write
  // refuses as stale rather than applying over newer work.
  const blocks = await readBlockTree(
    deps.pages.db,
    { ownerType: 'page', ownerId: pageId, locale },
    deps.pages.hooks,
  );

  try {
    await acquirePageLock(deps.pages, actor, { pageId });
  } catch (error) {
    // Someone else holds it, or locking is off: the view below says which.
    if (
      !(error instanceof PageLockedError) &&
      !(error instanceof PageLockingDisabledError)
    ) {
      throw error;
    }
  }
  const lock = await lockViewOf(context, pageId);

  return {
    pageId,
    locale,
    pageVersion: page.version,
    canDelete: deps.resolver
      .resolve(identity.roleKey, { userId: identity.userId })
      .has('pages:delete'),
    columnsEnabled: catalogue.some((entry) => entry.kind === 'column'),
    lock,
    catalogue,
    columnPresets: config.columnPresets,
    limits: {
      sectionNestingDepth: config.sectionNestingDepth,
      blockDepthCeiling: config.blockDepthCeiling,
      maxOps: BLOCK_EDIT_MAX_OPS,
      maxNodes: BLOCK_EDIT_MAX_NODES,
      heartbeatSeconds: PAGE_EDIT_LOCK_HEARTBEAT_SECONDS,
      lockTtlSeconds: PAGE_EDIT_LOCK_TTL_SECONDS,
    },
    tree: toModelNodes(blocks, config),
    upgraded: upgrade.upgraded,
  };
}

/** A page that is there and not in the trash, with its working tree. 404
 * otherwise. The page row is read before the tree, so the version never
 * claims to be newer than the tree it comes with. */
export async function readPageForest(
  context: ApiContext,
  pageId: string,
): Promise<{
  readonly page: PageRecord;
  readonly blocks: readonly BlockNode[];
}> {
  const { deps } = context;
  const page = await getPage(deps.pages.db, pageId);
  if (page === null || page.status === 'trashed') throw notFound();
  const blocks = await readBlockTree(
    deps.pages.db,
    { ownerType: 'page', ownerId: pageId, locale: page.locale },
    deps.pages.hooks,
  );
  return { page, blocks };
}

/** The page's current version and tree. 404 when the page is gone or in the
 * trash. */
export async function readTree(
  context: ApiContext,
  pageId: string,
): Promise<TreeResponse> {
  const { page, blocks } = await readPageForest(context, pageId);
  return {
    ok: true,
    pageVersion: page.version,
    tree: toModelNodes(blocks, context.deps.pages.config),
  };
}

async function lockResponse(
  context: ApiContext,
  pageId: string,
): Promise<LockResponse> {
  return { ok: true, lock: await lockViewOf(context, pageId) };
}

/** `GET .../lock`. */
export async function readLock(
  context: ApiContext,
  pageId: string,
): Promise<LockResponse> {
  return await lockResponse(context, pageId);
}

/** `POST .../lock/acquire`. */
export async function acquireLock(
  context: ApiContext,
  pageId: string,
): Promise<LockResponse> {
  await acquirePageLock(context.deps.pages, context.actor, { pageId });
  return await lockResponse(context, pageId);
}

/** `POST .../lock/renew`: the heartbeat. A lock nobody holds any more is
 * taken again rather than reported as lost. */
export async function renewLock(
  context: ApiContext,
  pageId: string,
): Promise<LockResponse> {
  const { pages } = context.deps;
  let renewed = false;
  try {
    renewed = await renewPageLock(pages, context.actor, { pageId });
  } catch (error) {
    if (!(error instanceof PageLockedError)) throw error;
    // The row still names someone else, but that does not say their lock is
    // live: it may have lapsed after their tab went away. Acquiring decides
    // by liveness, and refuses with the same error when it is still held.
  }
  if (!renewed) await acquirePageLock(pages, context.actor, { pageId });
  return await lockResponse(context, pageId);
}

/** `POST .../lock/release`. */
export async function releaseLock(
  context: ApiContext,
  pageId: string,
): Promise<LockResponse> {
  await releasePageLock(context.deps.pages, context.actor, { pageId });
  return await lockResponse(context, pageId);
}

/** `POST .../lock/take-over`: allowed only by the engine's permission
 * superset rule, which also audits it. */
export async function takeOverLock(
  context: ApiContext,
  pageId: string,
): Promise<LockResponse> {
  await takeOverPageLock(context.deps.pages, context.actor, { pageId });
  return await lockResponse(context, pageId);
}
