/**
 * Snapshot builder and audited publish (D-30, D-33). `buildSnapshotTree`
 * materialises the nested shape the renderer consumes, built in memory in
 * one pass (04-RESEARCH.md Open Question 2). `publishPage` reads the live
 * tree, records one `'publish'`-kind revision per block sharing one batch
 * id, builds the `revisionManifest`, and moves the page's live publication
 * pointer. This plan wires the one path where every block upcasts cleanly
 * -- the degraded-block refusal (D-31) and draft snapshots (D-32) are plan
 * 04-09's.
 */
import { createHash } from 'node:crypto';
import type { AuditActor } from '@plakboek/auth';
import { eq, sql } from 'drizzle-orm';
import type { PagesDeps } from './config.js';
import { loadPageForUpdate } from './pages.js';
import { newRevisionBatchId, recordBlockRevision } from './revisions.js';
import { pagePublications, pages } from './schema.js';
import { StalePageVersionError, readBlockTree } from './tree.js';
import type { BlockNode } from './types.js';

/** Materialises the nested shape the renderer consumes:
 * `{ blocks: [{ id, blockType, props, schemaVersion, children }] }`, built
 * in memory in one pass over the tree `readBlockTree` already assembled. */
export function buildSnapshotTree(
  nodes: readonly BlockNode[],
): Record<string, unknown> {
  function toSnapshotBlock(node: BlockNode): Record<string, unknown> {
    return {
      id: node.id,
      blockType: node.blockType,
      props: node.props,
      schemaVersion: node.schemaVersion,
      children: node.children.map(toSnapshotBlock),
    };
  }
  return { blocks: nodes.map(toSnapshotBlock) };
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
  readonly snapshot: Record<string, unknown>;
  readonly revisionManifest: Readonly<Record<string, string>>;
  readonly manifestHash: string;
  readonly publishedBy: string | null;
  readonly publishedAt: Date;
};

/** The lowercase hex sha256 of the manifest's keys, sorted and joined
 * (D-33) -- a hash Phase 5's cache can key on. */
function computeManifestHash(
  manifest: Readonly<Record<string, string>>,
): string {
  const sortedKeys = Object.keys(manifest).sort();
  return createHash('sha256').update(sortedKeys.join(',')).digest('hex');
}

/**
 * Publishes a page (D-30, D-33). Through `deps.recorder.run`
 * (`pages:publish` / `page.publish`): loads and locks the page `FOR
 * UPDATE`, throwing `StalePageVersionError` on a version mismatch; reads
 * the tree for `{ ownerType: 'page', ownerId: page.id, locale: page.locale
 * }`; records one `'publish'`-kind revision per block, all sharing one
 * batch id, building `revisionManifest` as `{ [blockId]: revisionId }` as
 * it goes; computes `manifestHash`; inserts a `page_publications` row with
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

      const tree = await readBlockTree(tx, {
        ownerType: 'page',
        ownerId: page.id,
        locale: page.locale,
      });

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

      const snapshot = buildSnapshotTree(tree);
      const manifestHash = computeManifestHash(manifest);

      const [publication] = await tx
        .insert(pagePublications)
        .values({
          pageId: page.id,
          locale: page.locale,
          isDraft: false,
          snapshot,
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

      const record: PagePublicationRecord = {
        id: publication.id,
        pageId: publication.pageId,
        locale: publication.locale,
        isDraft: publication.isDraft,
        snapshot: publication.snapshot,
        revisionManifest: manifest,
        manifestHash: publication.manifestHash,
        publishedBy: publication.publishedBy,
        publishedAt: publication.publishedAt,
      };

      return {
        result: record,
        after: { publicationId: record.id, manifestHash },
      };
    },
  );
}
