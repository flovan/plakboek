/**
 * The rule that a section always holds at least one column (D-03), as one
 * check every writer that can break it shares: the batch (`applyBlockEdit`),
 * the single-operation `moveBlock` and `deleteBlock`, and the history
 * restore. Internal wiring apart from the error class, which the barrel
 * re-exports.
 */
import type { AuditTransaction } from '@plakboek/auth';
import { and, eq, inArray } from 'drizzle-orm';
import { getColumnDefinition } from './registry.js';
import { pageBlocks } from './schema.js';

/** Thrown when a write would leave a section without a column (D-03): a
 * section always holds at least one column. Nothing has been written. */
export class SectionColumnRequiredError extends Error {
  readonly sectionId: string;

  constructor(sectionId: string) {
    super(
      `@plakboek/pages: section "${sectionId}" must keep at least one column`,
    );
    this.name = 'SectionColumnRequiredError';
    this.sectionId = sectionId;
  }
}

/**
 * Refuses the write when any of `sectionIds` that still exists holds no
 * column (`SectionColumnRequiredError`). A no-op when the registry declares no
 * column kind, and for an id that no longer names a block (a section the same
 * write deleted). Run it last, under the page lock, so the answer cannot
 * change before the commit.
 */
export async function assertSectionsHaveColumns(
  tx: AuditTransaction,
  sectionIds: Iterable<string>,
): Promise<void> {
  const column = getColumnDefinition();
  if (column === null) return;
  const candidates = [...new Set(sectionIds)];
  if (candidates.length === 0) return;

  const withColumn = new Set(
    (
      await tx
        .select({ parentId: pageBlocks.parentBlockId })
        .from(pageBlocks)
        .where(
          and(
            inArray(pageBlocks.parentBlockId, candidates),
            eq(pageBlocks.blockType, column.key),
          ),
        )
    ).map((row) => row.parentId),
  );
  const existing = await tx
    .select({ id: pageBlocks.id })
    .from(pageBlocks)
    .where(inArray(pageBlocks.id, candidates));
  const existingIds = new Set(existing.map((row) => row.id));
  for (const id of candidates) {
    if (existingIds.has(id) && !withColumn.has(id)) {
      throw new SectionColumnRequiredError(id);
    }
  }
}
