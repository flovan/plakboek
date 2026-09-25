/**
 * In-memory upcast-on-read (D-10, D-11, D-12, D-15, BLOCK-12). Never
 * mutates the stored row: the same `props` bytes are in Postgres before
 * and after a read -- the upgraded shape is written back only when the
 * block is next saved, or when `compactBlockType` (compaction.ts) performs
 * an audited force-upcast-and-write-back (D-11).
 *
 * `resolveUpcasterChain` is pure -- no `props` involved -- and therefore
 * safe to memoise per `(blockType, storedVersion)`. `createUpcastSession`
 * does exactly that, and only that: caching the *result* of applying a
 * chain would make two instances at the same stored version with
 * different props share one output, which is why the memo stops at the
 * resolved step list (04-RESEARCH.md Pattern 5).
 */
import { reportPagesWarning, type PagesHooks } from './config.js';
import {
  getBlockDefinition,
  UnknownBlockTypeError,
  type BlockDefinition,
  type BlockUpcaster,
} from './registry.js';

/** Every reason a stored block instance can fail to reach its registered
 * definition's current shape on read -- frozen so a consumer can
 * exhaustively `switch` on `DegradedReason`. */
export const DEGRADED_REASONS = Object.freeze([
  'no-upcaster',
  'upcaster-threw',
  'below-floor',
  'above-current',
  'unknown-block-type',
] as const);
export type DegradedReason = (typeof DEGRADED_REASONS)[number];

export type UpcastOutcome =
  | { readonly props: unknown; readonly degraded: false }
  | {
      readonly props: unknown;
      readonly degraded: true;
      readonly reason: DegradedReason;
      readonly detail?: string;
    };

type ChainStep = { readonly from: number; readonly fn: BlockUpcaster };

/** The pure (no `props` involved), therefore memoisable, resolution of one
 * `(blockType, storedVersion)` pair against a registered definition's
 * version lineage. */
export type UpcasterChainResolution =
  | { readonly kind: 'identity' }
  | { readonly kind: 'chain'; readonly steps: readonly ChainStep[] }
  | {
      readonly kind: 'degraded';
      readonly reason: DegradedReason;
      readonly detail?: string;
    };

/**
 * Resolves how `storedVersion` reaches `definition.schemaVersion` -- pure,
 * no `props` involved, and therefore safe to memoise (`createUpcastSession`
 * does exactly that). Checked in this order: `storedVersion ===
 * schemaVersion` is `identity`; a version above `schemaVersion` is
 * `degraded` with `above-current` (a rollback has no downcast path,
 * regardless of any floor or upcaster); a version under a declared
 * `minSupportedVersion` is `degraded` with `below-floor` (D-15), checked
 * BEFORE any step lookup, so a floored instance never reaches a host
 * upcaster function; otherwise the chain from `storedVersion` to
 * `schemaVersion` is walked, returning `degraded` with `no-upcaster` naming
 * the first missing step, or a `chain` of every `{ from, fn }` pair
 * required to reach the current version.
 */
export function resolveUpcasterChain(
  definition: BlockDefinition,
  storedVersion: number,
): UpcasterChainResolution {
  if (storedVersion === definition.schemaVersion) {
    return { kind: 'identity' };
  }
  if (storedVersion > definition.schemaVersion) {
    return { kind: 'degraded', reason: 'above-current' };
  }
  if (
    definition.minSupportedVersion !== undefined &&
    storedVersion < definition.minSupportedVersion
  ) {
    return { kind: 'degraded', reason: 'below-floor' };
  }

  const steps: ChainStep[] = [];
  for (
    let version = storedVersion;
    version < definition.schemaVersion;
    version += 1
  ) {
    const fn = definition.upcasters[version + 1];
    if (fn === undefined) {
      return {
        kind: 'degraded',
        reason: 'no-upcaster',
        detail: `block "${definition.key}" has no upcaster for step ${version + 1}`,
      };
    }
    steps.push({ from: version, fn });
  }
  return { kind: 'chain', steps: Object.freeze(steps) };
}

/** Applies an already-resolved chain to one row's own `props` -- never
 * itself memoised, so two rows sharing the identical resolved chain always
 * apply it to their own value. On a `degraded` resolution, or a step that
 * throws, returns the ORIGINAL `props` reference unchanged: never a clone,
 * never a partially upgraded intermediate. A thrown step is contained to
 * this one call -- the caller's sibling rows are unaffected. */
function applyResolution(
  resolution: UpcasterChainResolution,
  props: unknown,
): UpcastOutcome {
  if (resolution.kind === 'identity') {
    return { props, degraded: false };
  }
  if (resolution.kind === 'degraded') {
    return {
      props,
      degraded: true,
      reason: resolution.reason,
      ...(resolution.detail !== undefined ? { detail: resolution.detail } : {}),
    };
  }

  let current: unknown = props;
  for (const step of resolution.steps) {
    try {
      current = step.fn(current, step.from);
    } catch (error) {
      return {
        props,
        degraded: true,
        reason: 'upcaster-threw',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { props: current, degraded: false };
}

/**
 * Upcasts one row's `props` from `storedVersion` to
 * `definition.schemaVersion`, in memory, never touching storage (D-11).
 * Every failure mode is contained to this one row and returns the stored
 * `props` reference unchanged, flagged `degraded` with a `DegradedReason`
 * (`resolveUpcasterChain`'s doc comment names the classification order).
 * There is no path on which this function writes to the database, mutates
 * its `props` argument, or returns a partially upgraded shape as if it were
 * current.
 */
export function upcastOnRead(
  definition: BlockDefinition,
  storedVersion: number,
  props: unknown,
): UpcastOutcome {
  return applyResolution(
    resolveUpcasterChain(definition, storedVersion),
    props,
  );
}

export type UpcastSession = {
  /** Resolves the chain for `(blockType, storedVersion)` once per session
   * and reuses it; always applies the resolved chain to THIS call's own
   * `props`, never a cached result -- two instances at the same stored
   * version with different props never share an output. */
  upcast(
    blockType: string,
    storedVersion: number,
    props: unknown,
  ): UpcastOutcome;
};

/**
 * A per-tree-read cache of resolved upcaster chains, keyed by
 * `` `${blockType}@${storedVersion}` `` -- memoising ONLY the pure chain
 * resolution, never the applied result (04-RESEARCH.md Pattern 5): caching
 * the output would make two rows at the same stored version with different
 * props share one answer, which is why the memo stops at the step list.
 * Each session's memo is its own `Map`; nothing is shared across sessions
 * and nothing is cached across a process. An unregistered `blockType`
 * resolves `degraded` with `unknown-block-type`, caught from
 * `getBlockDefinition`'s `UnknownBlockTypeError`.
 */
export function createUpcastSession(): UpcastSession {
  const memo = new Map<string, UpcasterChainResolution>();

  function resolve(
    blockType: string,
    storedVersion: number,
  ): UpcasterChainResolution {
    const key = `${blockType}@${storedVersion}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let resolution: UpcasterChainResolution;
    try {
      const definition = getBlockDefinition(blockType);
      resolution = resolveUpcasterChain(definition, storedVersion);
    } catch (error) {
      if (!(error instanceof UnknownBlockTypeError)) throw error;
      resolution = { kind: 'degraded', reason: 'unknown-block-type' };
    }
    memo.set(key, resolution);
    return resolution;
  }

  return {
    upcast(blockType, storedVersion, props) {
      return applyResolution(resolve(blockType, storedVersion), props);
    },
  };
}

/** Emitted once per degraded row a tree read produces (D-12, D-14, D-15).
 * `currentVersion` is the registered definition's `schemaVersion`, or
 * `null` for `unknown-block-type` (no definition to read it from). The
 * stored row is never rewritten or dropped because of this event -- it is
 * a report only. */
export type DegradedBlockEvent = {
  readonly blockId: string;
  readonly blockType: string;
  readonly storedVersion: number;
  readonly currentVersion: number | null;
  readonly reason: DegradedReason;
  readonly detail?: string;
  readonly occurredAt: Date;
};

function defaultOnDegradedBlock(event: DegradedBlockEvent): void {
  // oxlint-disable-next-line no-console -- documented default fallback hook (D-12/D-15); a host overrides deps.hooks.onDegradedBlock to route elsewhere
  console.warn(
    `[@plakboek/pages] block "${event.blockId}" (type "${event.blockType}", stored v${event.storedVersion}) degraded on read: ${event.reason}${
      event.detail !== undefined ? ` -- ${event.detail}` : ''
    }`,
  );
}

/**
 * Reports one degraded row through `hooks?.onDegradedBlock` (or the
 * console-warning default) via `reportPagesWarning` -- never throws, even
 * when the hook itself throws or rejects. A degraded read is never a boot
 * failure and never a refused read (D-15); this function only ever reports.
 */
export function reportDegradedBlock(
  hooks: PagesHooks | undefined,
  event: DegradedBlockEvent,
): void {
  reportPagesWarning(hooks?.onDegradedBlock, defaultOnDegradedBlock, event);
}
