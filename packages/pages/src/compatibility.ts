/**
 * Boot-time replacement compatibility against stored instances (BLOCK-09,
 * D-06, D-15). Issues one aggregate read over `page_blocks` -- one row per
 * distinct `(block_type, schema_version)` pair with its instance count --
 * and classifies every stored version against each registered definition's
 * version lineage: identical to
 * `schemaVersion` is compatible; below a declared `minSupportedVersion` is
 * `belowFloor` (a warning, never a boot failure -- D-15); anything else
 * missing an upcaster step, or stored above the current `schemaVersion` (a
 * rollback with no downcast path), is `incompatible` and refuses at boot
 * (D-06). This function never writes: no row is read for any purpose other
 * than counting stored versions, and nothing here executes a host upcaster
 * (T-04-23) -- it only inspects which steps the declaration itself has.
 */
import type { AuditDatabase } from '@plakboek/auth';
import { sql } from 'drizzle-orm';
import type { PagesDeps } from './config.js';
import type { BlockDefinition } from './registry.js';
import { reportPagesWarning } from './config.js';

export type IncompatibleBlockEntry = {
  readonly blockKey: string;
  readonly storedVersions: readonly number[];
  readonly currentVersion: number;
  readonly missingSteps: readonly number[];
};

export type BelowFloorBlockEntry = {
  readonly blockKey: string;
  readonly storedVersions: readonly number[];
  readonly minSupportedVersion: number;
  readonly instanceCount: number;
};

export type BlockCompatibilityReport = {
  readonly incompatible: readonly IncompatibleBlockEntry[];
  readonly belowFloor: readonly BelowFloorBlockEntry[];
};

/** Emitted by `assertBlockCompatibility` for a block type holding instances
 * below its declared `minSupportedVersion` (D-14, D-15): a deliberately
 * declared floor degrades those rows at read time and never blocks a
 * deploy. Never thrown -- report only. */
export type BelowFloorEvent = {
  readonly blockKey: string;
  readonly storedVersions: readonly number[];
  readonly minSupportedVersion: number;
  readonly instanceCount: number;
  readonly occurredAt: Date;
};

/** Thrown by `assertBlockCompatibility` when a replacement's version
 * lineage cannot bring every stored instance to its current shape (D-06):
 * a host that swaps in its own implementation under an existing key and
 * forgets the version lineage finds out at boot, not when a visitor hits
 * the page. */
export class BlockCompatibilityError extends Error {
  readonly report: BlockCompatibilityReport;

  constructor(report: BlockCompatibilityReport) {
    super(
      [
        '[@plakboek/pages] block schema incompatible with stored instances:',
        ...report.incompatible.map(
          (entry) =>
            `block "${entry.blockKey}": stored version(s) ${entry.storedVersions.join(', ')} cannot reach current version ${entry.currentVersion}${
              entry.missingSteps.length > 0
                ? ` (missing upcaster step(s) ${entry.missingSteps.join(', ')})`
                : ' (stored above the current version -- no downcast path)'
            }`,
        ),
      ].join('\n'),
    );
    this.name = 'BlockCompatibilityError';
    this.report = report;
  }
}

/** Rows from a raw `execute()` result across drivers: postgres-js returns
 * the row array directly, node-postgres nests it under `.rows`. Mirrors
 * `tree.ts`'s helper of the same shape. */
function resultRows(result: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (typeof result === 'object' && result !== null) {
    const rows: unknown = Reflect.get(result, 'rows');
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(
      `@plakboek/pages: expected column "${field}" to be a string`,
    );
  }
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== 'number') {
    throw new TypeError(
      `@plakboek/pages: expected column "${field}" to be a number`,
    );
  }
  return value;
}

export type StoredVersionCount = {
  readonly schemaVersion: number;
  readonly count: number;
};

/**
 * The one grouped `block_type`/`schema_version` read this package performs
 * over `page_blocks` -- `checkBlockCompatibility` below and
 * `compaction.ts`'s `computeCompactionImpact` both call this instead of
 * each issuing their own aggregate query.
 */
export async function queryStoredVersionCounts(
  db: AuditDatabase,
): Promise<ReadonlyMap<string, readonly StoredVersionCount[]>> {
  const result: unknown = await db.execute(sql`
    SELECT block_type, schema_version, count(*)::int AS count
    FROM page_blocks
    GROUP BY block_type, schema_version
  `);

  const byBlockType = new Map<string, StoredVersionCount[]>();
  for (const row of resultRows(result)) {
    const blockType = asString(row.block_type, 'block_type');
    const schemaVersion = asNumber(row.schema_version, 'schema_version');
    const count = asNumber(row.count, 'count');
    const forType = byBlockType.get(blockType) ?? [];
    forType.push({ schemaVersion, count });
    byBlockType.set(blockType, forType);
  }
  return byBlockType;
}

/**
 * Classifies every stored `(block_type, schema_version)` pair against each
 * registered definition's version lineage, in one grouped read over
 * `page_blocks` (`queryStoredVersionCounts`). Never executes a host
 * `upcasters` function -- only checks which steps exist. A `block_type`
 * present in the database but absent from `definitions` is not this
 * function's concern -- `readBlockTree`'s `unknown-block-type` degraded
 * reason covers it at read time.
 */
export async function checkBlockCompatibility(
  db: AuditDatabase,
  definitions: readonly BlockDefinition[],
): Promise<BlockCompatibilityReport> {
  const byBlockType = await queryStoredVersionCounts(db);

  const incompatible: IncompatibleBlockEntry[] = [];
  const belowFloor: BelowFloorBlockEntry[] = [];

  for (const definition of definitions) {
    const stored = byBlockType.get(definition.key);
    if (stored === undefined) continue;

    const belowFloorVersions = new Set<number>();
    let belowFloorCount = 0;
    const incompatibleVersions = new Set<number>();
    const missingSteps = new Set<number>();

    for (const { schemaVersion: storedVersion, count } of stored) {
      if (storedVersion === definition.schemaVersion) continue;

      if (
        definition.minSupportedVersion !== undefined &&
        storedVersion < definition.minSupportedVersion
      ) {
        belowFloorVersions.add(storedVersion);
        belowFloorCount += count;
        continue;
      }

      if (storedVersion > definition.schemaVersion) {
        // A rollback to an older build: no downcast path exists.
        incompatibleVersions.add(storedVersion);
        continue;
      }

      let missingAStep = false;
      for (
        let step = storedVersion + 1;
        step <= definition.schemaVersion;
        step += 1
      ) {
        if (!(step in definition.upcasters)) {
          missingSteps.add(step);
          missingAStep = true;
        }
      }
      if (missingAStep) {
        incompatibleVersions.add(storedVersion);
      }
    }

    if (belowFloorVersions.size > 0) {
      belowFloor.push({
        blockKey: definition.key,
        storedVersions: Object.freeze(
          [...belowFloorVersions].sort((a, b) => a - b),
        ),
        minSupportedVersion: definition.minSupportedVersion as number,
        instanceCount: belowFloorCount,
      });
    }
    if (incompatibleVersions.size > 0) {
      incompatible.push({
        blockKey: definition.key,
        storedVersions: Object.freeze(
          [...incompatibleVersions].sort((a, b) => a - b),
        ),
        currentVersion: definition.schemaVersion,
        missingSteps: Object.freeze([...missingSteps].sort((a, b) => a - b)),
      });
    }
  }

  return Object.freeze({
    incompatible: Object.freeze(incompatible),
    belowFloor: Object.freeze(belowFloor),
  });
}

function defaultOnBelowFloor(event: BelowFloorEvent): void {
  // oxlint-disable-next-line no-console -- documented default fallback hook (D-15); a host overrides deps.hooks.onBelowFloor to route elsewhere
  console.warn(
    `[@plakboek/pages] block "${event.blockKey}" has ${event.instanceCount} stored instance(s) at version(s) ${event.storedVersions.join(', ')}, below its declared floor of ${event.minSupportedVersion} -- degraded at read time, not blocking boot`,
  );
}

/**
 * The D-06 boot gate: runs `checkBlockCompatibility` against `deps.config`'s
 * registered block definitions, reports every `belowFloor` entry through
 * `deps.hooks?.onBelowFloor` (or the console-warning default) -- never
 * thrown, since a deliberately declared floor degrades at read time (D-15)
 * -- and throws `BlockCompatibilityError` when any block is `incompatible`.
 * A host that replaces a block under an existing key without a version
 * lineage that reaches every stored instance finds out here, at boot, not
 * when a visitor hits the page.
 */
export async function assertBlockCompatibility(deps: PagesDeps): Promise<void> {
  const report = await checkBlockCompatibility(deps.db, deps.config.blocks);
  const now = deps.now ?? (() => new Date());

  for (const entry of report.belowFloor) {
    reportPagesWarning(deps.hooks?.onBelowFloor, defaultOnBelowFloor, {
      blockKey: entry.blockKey,
      storedVersions: entry.storedVersions,
      minSupportedVersion: entry.minSupportedVersion,
      instanceCount: entry.instanceCount,
      occurredAt: now(),
    });
  }

  if (report.incompatible.length > 0) {
    throw new BlockCompatibilityError(report);
  }
}
