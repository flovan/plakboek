/**
 * Per-block revision writer (D-26, D-27). Mirrors `@plakboek/content`'s
 * `recordRevision` insert-and-return shape. This module defines no update
 * for `block_revisions` -- once written, a revision row is only ever read
 * or (plan 04-08's cap-pruning sweep) deleted, never updated.
 */
import { randomUUID } from 'node:crypto';
import type { AuditTransaction } from '@plakboek/auth';
import { blockRevisions } from './schema.js';
import type { BlockChangeType, BlockRevisionKind, OwnerRef } from './types.js';

export type RecordBlockRevisionInput = {
  readonly blockId: string;
  readonly owner: OwnerRef;
  readonly revisionBatchId: string;
  readonly changeType: BlockChangeType;
  readonly kind: BlockRevisionKind;
  readonly blockType: string;
  readonly parentBlockId: string | null;
  readonly sortOrder: number;
  readonly depth: number;
  readonly props: unknown;
  readonly schemaVersion: number;
  readonly authorId: string | null;
  readonly createdAt: Date;
};

/** Generates one revision-batch id, shared by every `recordBlockRevision`
 * call a single save/publish makes (D-26) -- "what changed in this edit"
 * is then one query on `revision_batch_id`. */
export function newRevisionBatchId(): string {
  return randomUUID();
}

/**
 * Inserts one immutable `block_revisions` row through `deps.recorder.run`'s
 * transaction and returns its id, throwing when the insert returns no row.
 * `props` are stored raw, exactly as submitted, with the row's own
 * `schemaVersion` (D-13) -- never upcast at write time; upcasting only
 * ever runs on read (D-11).
 */
export async function recordBlockRevision(
  tx: AuditTransaction,
  input: RecordBlockRevisionInput,
): Promise<string> {
  const [row] = await tx
    .insert(blockRevisions)
    .values({
      blockId: input.blockId,
      ownerType: input.owner.ownerType,
      ownerId: input.owner.ownerId,
      locale: input.owner.locale,
      revisionBatchId: input.revisionBatchId,
      changeType: input.changeType,
      kind: input.kind,
      blockType: input.blockType,
      parentBlockId: input.parentBlockId,
      sortOrder: input.sortOrder,
      depth: input.depth,
      props: input.props,
      schemaVersion: input.schemaVersion,
      authorId: input.authorId,
      createdAt: input.createdAt,
    })
    .returning({ id: blockRevisions.id });
  if (row === undefined) {
    throw new Error('@plakboek/pages: block revision insert returned no row');
  }
  return row.id;
}
