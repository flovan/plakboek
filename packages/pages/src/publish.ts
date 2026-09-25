/**
 * Snapshot builder, degraded-block refusal and audited publish (D-30,
 * D-31, D-33). `buildSnapshotTree` materialises the nested shape the
 * renderer consumes, built in memory in one pass (04-RESEARCH.md Open
 * Question 2), emitting each block's `props` keys in its current
 * declaration order so two builds of the same tree serialise
 * byte-identically. `buildPageSnapshot` validates every node and refuses
 * with `DegradedBlockPublishError`, naming every offending block, before
 * anything is written: a knowingly broken snapshot is never stored, and a
 * refused publish leaves the previously published snapshot serving. Draft
 * snapshots (D-32) are plan 04-09's Task 2.
 */
import { createHash } from 'node:crypto';
import type { AuditActor, AuditDatabase } from '@plakboek/auth';
import { eq, sql } from 'drizzle-orm';
import type { PagesDeps } from './config.js';
import { loadPageForUpdate } from './pages.js';
import {
  BlockPropsValidationError,
  getBlockDefinition,
  resolveBlockProperties,
  validateBlockProps,
} from './registry.js';
import { newRevisionBatchId, recordBlockRevision } from './revisions.js';
import { pagePublications, pages } from './schema.js';
import { StalePageVersionError, readBlockTree } from './tree.js';
import type { BlockNode } from './types.js';
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

export type PageSnapshot = { readonly blocks: readonly SnapshotBlock[] };

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

/** One block that stopped a publish (or, from 04-09's Task 2, a draft
 * snapshot) from being built -- either already flagged `degraded` on read
 * (`versioning.ts`'s `DegradedReason`), or one whose upcast props failed
 * `validateBlockProps` against the current declaration
 * (`'invalid-props'`): a block that upcasts but does not validate is as
 * unpublishable as one that does not upcast at all. */
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
 * `buildPageSnapshot` is the single builder `publishPage` calls to turn a
 * tree into a snapshot, validating every node against its current
 * declaration first. Performs no I/O -- the whole tree materialises in
 * memory. Walks every node regardless of an earlier failure, so
 * `degraded` names EVERY offending block in one pass rather than stopping
 * at the first: a node already flagged `degraded` (by `readBlockTree`'s
 * upcast-on-read) is collected with its reason and contributes nothing
 * further; otherwise its `props` go through `validateBlockProps` -- a
 * `BlockPropsValidationError` collects the node with reason
 * `'invalid-props'` and the issue codes as `detail`. `snapshot` is only
 * ever built from the fully validated tree (via `buildSnapshotTree`) when
 * `degraded` is empty; when it is not, the caller (`publishPage`) throws
 * `DegradedBlockPublishError` before the (unusable) `snapshot` value is
 * ever read or written anywhere.
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

/** Thrown by `publishPage` when `buildPageSnapshot` reports one or more
 * degraded blocks -- thrown BEFORE any write, so a refused publish leaves
 * the previously published snapshot serving (D-31, T-04-38). A true
 * integrity break: this is one of the few places this engine refuses
 * rather than reporting and continuing. */
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

function asPageSnapshot(value: Record<string, unknown>): PageSnapshot {
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

/**
 * Publishes a page (D-30, D-31, D-33). Through `deps.recorder.run`
 * (`pages:publish` / `page.publish`): loads and locks the page `FOR
 * UPDATE`, throwing `StalePageVersionError` on a version mismatch --
 * before any of the below runs, so a stale publish writes nothing; reads
 * the tree for `{ ownerType: 'page', ownerId: page.id, locale: page.locale
 * }`; runs it through `buildPageSnapshot`, throwing
 * `DegradedBlockPublishError` when `degraded` is non-empty -- BEFORE any
 * write, so a refused publish leaves the previous publication serving;
 * records one `'publish'`-kind revision per block, all sharing one batch
 * id, building `revisionManifest` as `{ [blockId]: revisionId }` as it
 * goes; computes `manifestHash`; inserts a `page_publications` row with
 * `is_draft: false`; and moves the page's `live_publication_id`, `status`
 * to `'published'`, `published_at` and (only the first time) `
 * first_published_at`.
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
    async (tx) => {
      const page = await loadPageForUpdate(tx, input.pageId);
      if (page.version !== input.baseVersion) {
        throw new StalePageVersionError(
          page.id,
          input.baseVersion,
          page.version,
        );
      }

      const tree = await readBlockTree(
        tx,
        { ownerType: 'page', ownerId: page.id, locale: page.locale },
        deps.hooks,
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
          isDraft: false,
          snapshot: buildResult.snapshot,
          revisionManifest: manifest,
          manifestHash,
          publishedBy: actor.userId,
          publishedAt,
        })
        .returning();
      if (publication === undefined) {
        throw new Error(
          '@plakboek/pages: page publication insert returned no row',
        );
      }

      await tx
        .update(pages)
        .set({
          livePublicationId: publication.id,
          status: 'published',
          publishedAt,
          ...(page.firstPublishedAt === null
            ? { firstPublishedAt: publishedAt }
            : {}),
          version: sql`${pages.version} + 1`,
        })
        .where(eq(pages.id, page.id));

      const record = toPagePublicationRecord(publication);

      return {
        result: record,
        after: {
          publicationId: record.id,
          manifestHash,
          blockCount: Object.keys(manifest).length,
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
