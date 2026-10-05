/**
 * Snapshot builder, degraded-block refusal, publish and draft snapshot
 * (D-30, D-31, D-32, D-33). `buildSnapshotTree` materialises the nested
 * shape the renderer consumes, built in memory in one pass (04-RESEARCH.md
 * Open Question 2), emitting each block's `props` keys in its current
 * declaration order so two builds of the same tree serialise
 * byte-identically. `buildPageSnapshot` validates every node and refuses
 * with `DegradedBlockPublishError`, naming every offending block, before
 * anything is written: a knowingly broken snapshot is never stored, and a
 * refused publish (or draft) leaves the previously published snapshot
 * serving. `publishPage` and `createDraftSnapshot` both funnel through the
 * private `materialisePublication` helper, so a draft provably cannot
 * differ from what publishing the same tree would produce (D-32).
 */
import { createHash } from 'node:crypto';
import type {
  AuditActor,
  AuditDatabase,
  AuditTransaction,
} from '@plakboek/auth';
import { normalizeEntrySeo } from '@plakboek/content';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { PagesDeps, PagesHooks } from './config.js';
import { assertPageWritable } from './locks.js';
import { getPage, loadPageForUpdate, PageNotFoundError } from './pages.js';
import {
  assertPageAddressAvailable,
  assertPageAddressReachable,
  computePageResolvedPath,
  pageUrlCollisionFromUniqueViolation,
} from './page-routing.js';
import {
  BlockPropsValidationError,
  getBlockDefinition,
  resolveBlockProperties,
  validateBlockProps,
} from './registry.js';
import { registerPagePurge } from './purge.js';
import { newRevisionBatchId, recordBlockRevision } from './revisions.js';
import { pagePublications, pages } from './schema.js';
import { getPageEditLocking, getPageUrlPattern } from './settings.js';
import { StalePageVersionError, readBlockTree } from './tree.js';
import type { BlockNode, PageRecord } from './types.js';
import type { DegradedReason } from './versioning.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One block in the materialised, nested snapshot shape the Phase 5
 * renderer walks -- a section and an ordinary block differ only by their
 * `blockType` and their `children`, never by a `kind` branch (D-16). */
export type SnapshotBlock = {
  readonly id: string;
  readonly blockType: string;
  readonly schemaVersion: number;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly SnapshotBlock[];
};

/** The head-relevant subset of a page's SEO set, as frozen into a published
 * snapshot (D-13). Structurally assignable to `@plakboek/render`'s
 * `PageSeoInput`. `sitemapInclude` is a sitemap concern, not a head one. */
export type PublishedPageSeo = {
  readonly title: string | null;
  readonly description: string | null;
  readonly imageAssetId: string | null;
  readonly canonicalUrl: string | null;
  readonly noindex: boolean;
  readonly nofollow: boolean;
};

/**
 * What a publication freezes: the block tree plus the page's `title` and head
 * SEO set as they were when it was published, so a retitle or an SEO edit only
 * reaches visitors through a publish, exactly like a block edit.
 *
 * `title` and `seo` are optional only because a snapshot written before they
 * were materialised carries neither; `readSnapshotPageMeta` is the one reader
 * and decides what such a snapshot serves. Every snapshot written now has both.
 */
export type PageSnapshot = {
  readonly blocks: readonly SnapshotBlock[];
  readonly title?: string;
  readonly seo?: PublishedPageSeo;
};

/** Picks the head fields out of a stored SEO value; never throws. */
function toPublishedPageSeo(value: unknown): PublishedPageSeo {
  const seo = normalizeEntrySeo(value);
  return {
    title: seo.title,
    description: seo.description,
    imageAssetId: seo.imageAssetId,
    canonicalUrl: seo.canonicalUrl,
    noindex: seo.noindex,
    nofollow: seo.nofollow,
  };
}

/**
 * The title and head SEO set a published snapshot carries. A snapshot
 * published before these were materialised (no `title`, no `seo`) serves an
 * empty title and the default SEO set (indexable, no overrides) until the page
 * is republished: reading the live `pages` row instead would put working data
 * back on the visitor path. The default SEO set is also what such a page
 * served before, because no writer for a page's SEO exists yet; only the
 * title is lost, and republishing restores it.
 */
export function readSnapshotPageMeta(snapshot: PageSnapshot): {
  readonly title: string;
  readonly seo: PublishedPageSeo;
} {
  return {
    title: typeof snapshot.title === 'string' ? snapshot.title : '',
    seo: toPublishedPageSeo(snapshot.seo),
  };
}

/**
 * Materialises the nested shape the renderer consumes, built in memory in
 * one pass over the tree `readBlockTree` already assembled -- no branch on
 * `kind` anywhere in this walk, which is what lets the Phase 5 renderer
 * walk one recursion for both a section and an ordinary block. Each
 * block's `props` are emitted with their keys in the order
 * `resolveBlockProperties(definition)` returns them for that block's
 * current declaration, omitting any key the declaration no longer carries
 * -- so two builds of the same tree serialise byte-identically and
 * `computeManifestHash`'s sibling, a cache key over the snapshot itself,
 * is stable. Assumes every node's `props` are already the validated,
 * current-shape props -- `buildPageSnapshot` is the caller that
 * guarantees this before ever reaching here.
 */
export function buildSnapshotTree(nodes: readonly BlockNode[]): PageSnapshot {
  function toSnapshotBlock(node: BlockNode): SnapshotBlock {
    const definition = getBlockDefinition(node.blockType);
    const resolvedProperties = resolveBlockProperties(definition);
    const rawProps = isPlainObject(node.props) ? node.props : {};
    const orderedProps: Record<string, unknown> = {};
    for (const propertyKey of Object.keys(resolvedProperties)) {
      if (propertyKey in rawProps) {
        orderedProps[propertyKey] = rawProps[propertyKey];
      }
    }
    return {
      id: node.id,
      blockType: node.blockType,
      schemaVersion: node.schemaVersion,
      props: Object.freeze(orderedProps),
      children: Object.freeze(node.children.map(toSnapshotBlock)),
    };
  }
  return { blocks: Object.freeze(nodes.map(toSnapshotBlock)) };
}

/** One block that stopped a publish or a draft snapshot from being built --
 * either already flagged `degraded` on read (`versioning.ts`'s
 * `DegradedReason`), or one whose upcast props failed `validateBlockProps`
 * against the current declaration (`'invalid-props'`): a block that
 * upcasts but does not validate is as unpublishable as one that does not
 * upcast at all. */
export type DegradedSnapshotBlock = {
  readonly blockId: string;
  readonly blockType: string;
  readonly reason: DegradedReason | 'invalid-props';
  readonly detail?: string;
};

export type SnapshotBuildResult = {
  readonly snapshot: PageSnapshot;
  readonly degraded: readonly DegradedSnapshotBlock[];
  readonly revisionSourceIds: readonly string[];
};

/**
 * `buildPageSnapshot` is the single builder both `publishPage` and
 * `createDraftSnapshot` call (via `materialisePublication`) to turn a tree
 * into a snapshot, validating every node against its current declaration
 * first. Performs no I/O -- the whole tree materialises in memory. Walks
 * every node regardless of an earlier failure, so `degraded` names EVERY
 * offending block in one pass rather than stopping at the first: a node
 * already flagged `degraded` (by `readBlockTree`'s upcast-on-read) is
 * collected with its reason and contributes nothing further; otherwise its
 * `props` go through `validateBlockProps` -- a `BlockPropsValidationError`
 * collects the node with reason `'invalid-props'` and the issue codes as
 * `detail`. `snapshot` is only ever built from the fully validated tree
 * (via `buildSnapshotTree`) when `degraded` is empty; when it is not, the
 * caller (`materialisePublication`) throws `DegradedBlockPublishError`
 * before the (unusable) `snapshot` value is ever read or written anywhere.
 */
export function buildPageSnapshot(
  nodes: readonly BlockNode[],
): SnapshotBuildResult {
  const degraded: DegradedSnapshotBlock[] = [];
  const revisionSourceIds: string[] = [];

  function resolveNode(node: BlockNode): BlockNode {
    revisionSourceIds.push(node.id);
    const children = Object.freeze(node.children.map(resolveNode));

    if (node.degraded) {
      degraded.push({
        blockId: node.id,
        blockType: node.blockType,
        reason: node.degradedReason as DegradedReason,
      });
      return { ...node, children };
    }

    try {
      const definition = getBlockDefinition(node.blockType);
      const validatedProps = validateBlockProps(definition, node.props);
      return { ...node, props: validatedProps, children };
    } catch (error) {
      if (!(error instanceof BlockPropsValidationError)) throw error;
      degraded.push({
        blockId: node.id,
        blockType: node.blockType,
        reason: 'invalid-props',
        detail: error.issues
          .map((issue) => `"${issue.propertyKey}": ${issue.code}`)
          .join('; '),
      });
      return { ...node, children };
    }
  }

  const resolvedNodes = nodes.map(resolveNode);
  const snapshot =
    degraded.length === 0
      ? buildSnapshotTree(resolvedNodes)
      : { blocks: Object.freeze([]) };

  return {
    snapshot,
    degraded: Object.freeze(degraded),
    revisionSourceIds: Object.freeze(revisionSourceIds),
  };
}

/** The lowercase hex sha256 of the manifest's `key:value` entries, sorted
 * by key and joined with a separator that cannot appear in a uuid, so key
 * order can never change the hash (D-33) -- a cache key Phase 5 can key
 * on. */
export function computeManifestHash(
  manifest: Readonly<Record<string, string>>,
): string {
  const sortedKeys = Object.keys(manifest).sort();
  const serialized = sortedKeys
    .map((key) => `${key}:${manifest[key]}`)
    .join('\n');
  return createHash('sha256').update(serialized).digest('hex');
}

/** Thrown by `publishPage`/`createDraftSnapshot` when `buildPageSnapshot`
 * reports one or more degraded blocks -- thrown BEFORE any write, so a
 * refused publish or draft leaves the previously published snapshot
 * serving (D-31, T-04-38). A true integrity break: this is one of the few
 * places this engine refuses rather than reporting and continuing. */
export class DegradedBlockPublishError extends Error {
  readonly blocks: readonly DegradedSnapshotBlock[];

  constructor(blocks: readonly DegradedSnapshotBlock[]) {
    super(
      [
        `[@plakboek/pages] cannot publish: ${blocks.length} block(s) are degraded:`,
        ...blocks.map(
          (block) =>
            `  - ${block.blockId} (${block.blockType}): ${block.reason}${
              block.detail !== undefined ? ` -- ${block.detail}` : ''
            }`,
        ),
      ].join('\n'),
    );
    this.name = 'DegradedBlockPublishError';
    this.blocks = Object.freeze(blocks.map((block) => ({ ...block })));
  }
}

export function asPageSnapshot(value: Record<string, unknown>): PageSnapshot {
  return value as unknown as PageSnapshot;
}

function toPagePublicationRecord(
  row: typeof pagePublications.$inferSelect,
): PagePublicationRecord {
  return {
    id: row.id,
    pageId: row.pageId,
    locale: row.locale,
    isDraft: row.isDraft,
    snapshot: asPageSnapshot(row.snapshot),
    revisionManifest: row.revisionManifest,
    manifestHash: row.manifestHash,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt,
  };
}

export type PublishPageInput = {
  readonly pageId: string;
  readonly baseVersion: number;
};

export type CreateDraftSnapshotInput = {
  readonly pageId: string;
};

export type PagePublicationRecord = {
  readonly id: string;
  readonly pageId: string;
  readonly locale: string;
  readonly isDraft: boolean;
  readonly snapshot: PageSnapshot;
  readonly revisionManifest: Readonly<Record<string, string>>;
  readonly manifestHash: string;
  readonly publishedBy: string | null;
  readonly publishedAt: Date;
};

type MaterialisePublicationResult = {
  readonly record: PagePublicationRecord;
  readonly blockCount: number;
};

/**
 * Turns one owner's live tree into a stored `page_publications` row -- the
 * ONE code path `publishPage` and `createDraftSnapshot` both call, so
 * D-32's guarantee (a preview provably cannot differ from what publishing
 * will produce) is structural rather than aspirational. Reads the tree
 * (`readBlockTree`, forwarding `hooks` so a degraded block still reports
 * through the normal read-time hook too) and runs it through
 * `buildPageSnapshot`; a non-empty `degraded` list throws
 * `DegradedBlockPublishError` before any write. Records one `'publish'`-
 * kind `recordBlockRevision` per block, all sharing one
 * `newRevisionBatchId()`, building the `revisionManifest` as `{ [blockId]:
 * revisionId }` from those exact ids -- so a publish's and a draft's
 * manifest-referenced revisions are both `'publish'`-kind and therefore
 * never pruned (D-28). Inserts the `page_publications` row with
 * `is_draft` set from `options.isDraft`. Only a non-draft additionally
 * materialises the page's address (D-22): reads the project-wide pattern
 * (`getPageUrlPattern`), computes `resolved_path` from this page's own
 * `locale`/`path` (`computePageResolvedPath`), and checks it is free
 * (`assertPageAddressAvailable`) and that its public path leads back to the
 * page (`assertPageAddressReachable`) before writing it -- a 23505 on
 * `pages_locale_resolved_path_unique` from a concurrent publish racing
 * past that check is mapped through `pageUrlCollisionFromUniqueViolation`
 * into the same domain error, never a bare driver error. It then moves the
 * owning page's `live_publication_id`, `status` to `'published'`,
 * `published_at` and (only the first time) its first-published marker,
 * and bumps `pages.version` -- a draft touches none of those, including
 * the address: taking a preview is not an edit.
 */
async function materialisePublication(
  tx: AuditTransaction,
  page: PageRecord,
  actor: AuditActor,
  now: () => Date,
  hooks: PagesHooks | undefined,
  options: {
    readonly isDraft: boolean;
    /** The locale set the page's public path is checked against. */
    readonly content: { locales: readonly string[]; defaultLocale: string };
  },
): Promise<MaterialisePublicationResult> {
  // The one guard call this whole module needs: covers `publishPage` (a
  // real edit, version-checked by its own caller before this helper ever
  // runs) and `createDraftSnapshot` (which takes no `baseVersion` at all) --
  // a colleague's live lock on the page refuses a preview exactly as it
  // refuses a real publish, since a preview reads the same live tree a
  // publish would (D-32).
  assertPageWritable([page], await getPageEditLocking(tx), actor.userId, now());

  const tree = await readBlockTree(
    tx,
    { ownerType: 'page', ownerId: page.id, locale: page.locale },
    hooks,
  );

  const buildResult = buildPageSnapshot(tree);
  if (buildResult.degraded.length > 0) {
    throw new DegradedBlockPublishError(buildResult.degraded);
  }

  const batchId = newRevisionBatchId();
  const publishedAt = now();
  const manifest: Record<string, string> = {};

  async function recordPublishRevisions(
    nodes: readonly BlockNode[],
  ): Promise<void> {
    for (const node of nodes) {
      const revisionId = await recordBlockRevision(tx, {
        blockId: node.id,
        owner: {
          ownerType: node.ownerType,
          ownerId: node.ownerId,
          locale: node.locale,
        },
        revisionBatchId: batchId,
        changeType: 'update',
        kind: 'publish',
        blockType: node.blockType,
        parentBlockId: node.parentBlockId,
        sortOrder: node.sortOrder,
        depth: node.depth,
        props: node.props,
        schemaVersion: node.schemaVersion,
        authorId: actor.userId,
        createdAt: publishedAt,
      });
      manifest[node.id] = revisionId;
      await recordPublishRevisions(node.children);
    }
  }
  await recordPublishRevisions(tree);

  const manifestHash = computeManifestHash(manifest);

  const [publication] = await tx
    .insert(pagePublications)
    .values({
      pageId: page.id,
      locale: page.locale,
      isDraft: options.isDraft,
      snapshot: {
        ...buildResult.snapshot,
        title: page.title,
        seo: toPublishedPageSeo(page.seo),
      },
      revisionManifest: manifest,
      manifestHash,
      publishedBy: actor.userId,
      publishedAt,
    })
    .returning();
  if (publication === undefined) {
    throw new Error('@plakboek/pages: page publication insert returned no row');
  }

  if (!options.isDraft) {
    const pattern = await getPageUrlPattern(tx);
    const resolvedPath = computePageResolvedPath({
      pattern,
      locale: page.locale,
      path: page.path,
    });
    await assertPageAddressAvailable(tx, {
      locale: page.locale,
      resolvedPath,
      excludePageId: page.id,
    });
    assertPageAddressReachable({
      pattern,
      locale: page.locale,
      path: page.path,
      locales: options.content.locales,
      defaultLocale: options.content.defaultLocale,
    });

    try {
      await tx
        .update(pages)
        .set({
          livePublicationId: publication.id,
          status: 'published',
          resolvedPath,
          publishedAt,
          ...(page.firstPublishedAt === null
            ? { firstPublishedAt: publishedAt }
            : {}),
          version: sql`${pages.version} + 1`,
        })
        .where(eq(pages.id, page.id));
    } catch (error) {
      const collision = pageUrlCollisionFromUniqueViolation(error, {
        locale: page.locale,
        resolvedPath,
      });
      if (collision !== null) throw collision;
      throw error;
    }
  }

  const record = toPagePublicationRecord(publication);
  return { record, blockCount: Object.keys(manifest).length };
}

/**
 * Publishes a page (D-30, D-31, D-33). Through `deps.recorder.run`
 * (`pages:publish` / `page.publish`): loads and locks the page `FOR
 * UPDATE`, throwing `StalePageVersionError` on a base-version mismatch --
 * BEFORE `materialisePublication` ever runs, so a stale publish writes
 * nothing. `materialisePublication` does the rest: reads the tree, refuses
 * `DegradedBlockPublishError` on any degraded or invalid block (leaving
 * the previously published snapshot serving), records one `'publish'`-
 * kind revision per block, inserts the publication row, and moves the
 * page's live publication pointer.
 */
export async function publishPage(
  deps: PagesDeps,
  actor: AuditActor,
  input: PublishPageInput,
): Promise<PagePublicationRecord> {
  const now = deps.now ?? (() => new Date());

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:publish',
      action: 'page.publish',
      entityType: 'page',
      entityId: input.pageId,
    },
    async (tx, context) => {
      const page = await loadPageForUpdate(tx, input.pageId);
      if (page.version !== input.baseVersion) {
        throw new StalePageVersionError(
          page.id,
          input.baseVersion,
          page.version,
        );
      }

      const { record, blockCount } = await materialisePublication(
        tx,
        page,
        actor,
        now,
        deps.hooks,
        { isDraft: false, content: deps.config.content },
      );

      // Purges after this transaction commits (D-18, purge.ts).
      registerPagePurge(deps, context, [page.id]);

      return {
        result: record,
        after: {
          publicationId: record.id,
          manifestHash: record.manifestHash,
          blockCount,
        },
      };
    },
  );
}

/**
 * Builds a draft snapshot from a page's CURRENT tree (D-32) -- the
 * identical `materialisePublication` helper `publishPage` calls, so a
 * preview provably cannot differ from what publishing the same tree would
 * produce. Through `deps.recorder.run` (`pages:read-drafts` /
 * `page.draft-snapshot`). Takes no `baseVersion`: a preview reads whatever
 * the tree currently is, and there is no lost-update risk because it
 * writes nothing to `pages` or `page_blocks` -- only a new
 * `page_publications` row with `is_draft` true. Refuses
 * `DegradedBlockPublishError` on the same terms a publish would: a preview
 * that silently omitted a broken block would be a preview that lies.
 */
export async function createDraftSnapshot(
  deps: PagesDeps,
  actor: AuditActor,
  input: CreateDraftSnapshotInput,
): Promise<PagePublicationRecord> {
  const now = deps.now ?? (() => new Date());

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:read-drafts',
      action: 'page.draft-snapshot',
      entityType: 'page',
      entityId: input.pageId,
    },
    async (tx) => {
      // A draft snapshot is never visitor-reachable, so it purges nothing.
      const page = await getPage(tx, input.pageId);
      if (page === null) {
        throw new PageNotFoundError(input.pageId);
      }

      const { record, blockCount } = await materialisePublication(
        tx,
        page,
        actor,
        now,
        deps.hooks,
        { isDraft: true, content: deps.config.content },
      );

      return {
        result: record,
        after: {
          publicationId: record.id,
          manifestHash: record.manifestHash,
          blockCount,
        },
      };
    },
  );
}

/**
 * Reads the row `pages.live_publication_id` points at -- one row read, no
 * join to `page_blocks`, no registry lookup. This is the function Phase 5
 * will call, and the reason the snapshot carries everything the visitor
 * path needs.
 */
export async function readPublishedSnapshot(
  db: AuditDatabase,
  input: { readonly pageId: string },
): Promise<PagePublicationRecord | null> {
  const [pageRow] = await db
    .select({ livePublicationId: pages.livePublicationId })
    .from(pages)
    .where(eq(pages.id, input.pageId))
    .limit(1);
  if (pageRow === undefined || pageRow.livePublicationId === null) {
    return null;
  }
  const [publicationRow] = await db
    .select()
    .from(pagePublications)
    .where(eq(pagePublications.id, pageRow.livePublicationId))
    .limit(1);
  return publicationRow === undefined
    ? null
    : toPagePublicationRecord(publicationRow);
}

/**
 * Reads the newest `is_draft` row for a page, ordered `published_at DESC,
 * id DESC` via `page_publications_page_draft_published_idx`, or `null`
 * when none exists. Two successive draft snapshots leave two rows; this
 * never deletes either. Phase 13 attaches its temporary preview URLs to
 * the row this returns rather than inventing a parallel mechanism.
 */
export async function readLatestDraftSnapshot(
  db: AuditDatabase,
  input: { readonly pageId: string },
): Promise<PagePublicationRecord | null> {
  const [row] = await db
    .select()
    .from(pagePublications)
    .where(
      and(
        eq(pagePublications.pageId, input.pageId),
        eq(pagePublications.isDraft, true),
      ),
    )
    .orderBy(desc(pagePublications.publishedAt), desc(pagePublications.id))
    .limit(1);
  return row === undefined ? null : toPagePublicationRecord(row);
}
