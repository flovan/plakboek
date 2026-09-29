/**
 * Host-code pages configuration and the dependency bag every engine
 * operation takes. Mirrors `@plakboek/content`'s `config.ts` shape exactly:
 * `definePagesConfig` collects every problem and throws one
 * `PagesConfigError` (never fails on the first bad field). `blocks` is
 * already the frozen, validated array a host produced by calling
 * `defineBlocks` itself (registry.ts) -- `definePagesConfig` does not call
 * `defineBlocks` on the caller's behalf, so a `BlockConfigError` and a
 * `PagesConfigError` are never conflated.
 *
 * `definePagesConfig` is the single registration door blocks, host field
 * types and host widgets all enter through (EXT-02, D-07): it forwards
 * `fieldTypes`/`widgets` to `@plakboek/content`'s own validating doors
 * (`registerHostFieldType`, `registerHostWidget`) in array order, each
 * under the identical last-wins-by-array-position rule `defineBlocks`
 * already applies to blocks -- one override rule serves all three kinds.
 * After `applyBlockConstraints` (constraints.ts, D-04) resolves each block's
 * per-property constraints, `registerResolvedBlocks` (registry.ts)
 * re-populates the module-level registry with those SAME constrained
 * definitions, so `getBlockDefinition` -- and every write/publish path that
 * calls it -- can never resolve a different, unconstrained definition than
 * the one this function returns as `PagesConfig.blocks`.
 */
import type { AuditDatabase, AuditRecorder } from '@plakboek/auth';
import {
  registerHostWidget,
  registerHostFieldType,
  type ContentConfig,
  type HostFieldTypeDefinition,
  type HostWidgetDefinition,
  type ShadowedFieldTypeEvent,
} from '@plakboek/content';
import type { PermissionResolver } from '@plakboek/permissions';
import type { BelowFloorEvent } from './compatibility.js';
import {
  applyBlockConstraints,
  type BlockConstraintSet,
} from './constraints.js';
import { registerResolvedBlocks, type BlockDefinition } from './registry.js';
import {
  lintSectionProperties,
  reportSectionLint,
  type SectionLintEvent,
} from './section-lint.js';
import type { DegradedBlockEvent } from './versioning.js';

// `reportPagesWarning` is defined in `warnings.ts`, a dependency-free leaf
// module, and re-exported here unchanged so every existing
// `from './config.js'` import (compatibility.ts, this package's barrel)
// keeps resolving -- `definePagesConfig` itself calls into `section-lint.ts`
// below, and `section-lint.ts` needs `reportPagesWarning` too, so defining
// it in `config.ts` directly would create a `config.ts <-> section-lint.ts`
// circular value import (the same class of cycle `field-type-ids.ts`'s
// extraction avoided for `registry.ts`, STATE.md's Phase 4 quick task).
export { reportPagesWarning } from './warnings.js';

export const DEFAULT_SECTION_NESTING_DEPTH = 2;
export const DEFAULT_BLOCK_DEPTH_CEILING = 12;

export type PagesConfig = {
  readonly content: ContentConfig;
  readonly blocks: readonly BlockDefinition[];
  readonly sectionNestingDepth: number;
  readonly blockDepthCeiling: number;
};

export type PagesConfigInput = {
  readonly content: ContentConfig;
  readonly blocks: readonly BlockDefinition[];
  readonly fieldTypes?: readonly HostFieldTypeDefinition[];
  readonly widgets?: readonly HostWidgetDefinition[];
  readonly constraints?: readonly BlockConstraintSet[];
  readonly sectionNestingDepth?: number;
  readonly blockDepthCeiling?: number;
  readonly hooks?: PagesHooks;
};

export type PagesConfigIssueCode =
  | 'NO_BLOCKS'
  | 'INVALID_SECTION_NESTING_DEPTH'
  | 'INVALID_BLOCK_DEPTH_CEILING';

export type PagesConfigIssue = {
  readonly code: PagesConfigIssueCode;
  readonly value?: unknown;
  readonly message: string;
};

/** Thrown by `definePagesConfig` with every problem found in the host's
 * config, collected before throwing once. */
export class PagesConfigError extends Error {
  readonly issues: readonly PagesConfigIssue[];

  constructor(issues: readonly PagesConfigIssue[]) {
    super(
      [
        '[@plakboek/pages] invalid pages config:',
        ...issues.map((issue) => issue.message),
      ].join('\n'),
    );
    this.name = 'PagesConfigError';
    this.issues = issues;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * Validates and freezes a host's pages config. Throws a single
 * `PagesConfigError` listing every problem found (no blocks declared, an
 * invalid `sectionNestingDepth`/`blockDepthCeiling`); on success returns a
 * frozen copy, defaulting `sectionNestingDepth` to
 * `DEFAULT_SECTION_NESTING_DEPTH` (D-18) and `blockDepthCeiling` to
 * `DEFAULT_BLOCK_DEPTH_CEILING` (04-RESEARCH.md Pitfall 6 / assumption A2).
 *
 * Call this exactly ONCE per process (registry.ts's own `WARNING` comment
 * has the full hazard): it re-populates `registry.ts`'s process-wide,
 * module-level block registry via `registerResolvedBlocks`, so a second,
 * unrelated call in the same process -- a second host config composed
 * alongside this one, or two test files sharing a Vitest worker without
 * isolating module state -- silently reverts every subsequent
 * `getBlockDefinition` read to that second call's definitions, desyncing
 * this call's `PagesConfig.blocks` from what the registry actually enforces,
 * with no error raised anywhere (code review WR-04).
 */
export function definePagesConfig(input: PagesConfigInput): PagesConfig {
  // The single registration door (EXT-02, D-07): field types, then widgets,
  // each walking its own array in order under the identical
  // last-wins-by-array-position rule `defineBlocks` already applies to
  // blocks. `blocks` itself is not registered here -- it is already the
  // frozen array a host produced by calling `defineBlocks` before reaching
  // this call (this module's header comment) -- but its per-property
  // constraints are applied below, once every declaration and every host
  // registration exists. A `HostRegistrationError` from either forwarded
  // call propagates unchanged -- never wrapped in `PagesConfigError` -- so a
  // field-type/widget registration problem and a pages-config problem are
  // never conflated, exactly like `BlockConfigError`/`BlockConstraintError`
  // and `PagesConfigError` never are.
  registerHostFieldType(input.fieldTypes ?? [], {
    onShadowedFieldType: input.hooks?.onShadowedFieldType,
  });
  registerHostWidget(input.widgets ?? []);

  const issues: PagesConfigIssue[] = [];

  if (!Array.isArray(input.blocks) || input.blocks.length === 0) {
    issues.push({
      code: 'NO_BLOCKS',
      message: 'pages config must declare at least one block',
    });
  }

  const sectionNestingDepth =
    input.sectionNestingDepth ?? DEFAULT_SECTION_NESTING_DEPTH;
  if (!isPositiveInteger(sectionNestingDepth)) {
    issues.push({
      code: 'INVALID_SECTION_NESTING_DEPTH',
      value: sectionNestingDepth,
      message: 'sectionNestingDepth must be an integer of at least 1',
    });
  }

  const blockDepthCeiling =
    input.blockDepthCeiling ?? DEFAULT_BLOCK_DEPTH_CEILING;
  if (!isPositiveInteger(blockDepthCeiling)) {
    issues.push({
      code: 'INVALID_BLOCK_DEPTH_CEILING',
      value: blockDepthCeiling,
      message: 'blockDepthCeiling must be an integer of at least 1',
    });
  }

  if (issues.length > 0) {
    throw new PagesConfigError(issues);
  }

  // `applyBlockConstraints` (constraints.ts, D-04) validates every
  // constraint set against the real, already-composed block declarations
  // and returns each definition with its resolved `constraints` map
  // attached. A `BlockConstraintError` propagates unchanged here too --
  // never wrapped in `PagesConfigError` -- for the same reason a
  // `BlockConfigError`/`HostRegistrationError` above never is.
  const blocks = applyBlockConstraints(input.blocks, input.constraints ?? []);

  // `defineBlocks` (registry.ts) already populated the module-level
  // registry with the UNCONSTRAINED definitions -- `getBlockDefinition` and
  // everything reading through it (`insertBlock`, `updateBlockProps`,
  // `moveBlock`, `buildPageSnapshot`, ...) must resolve the SAME constrained
  // definitions this function returns as `PagesConfig.blocks`, or a declared
  // `hidden`/`fixed`/`narrowed` constraint would type-check and boot cleanly
  // while having zero effect on any real write or publish path. This is the
  // one call that keeps the two in sync (D-04).
  registerResolvedBlocks(blocks);

  // The D-17 boot-time section lint (section-lint.ts) runs last, only after
  // registration and every collect-then-throw validation above has already
  // succeeded -- a config that throws for a real reason never also emits
  // lint noise. This never throws itself: a flagged section property is
  // reported, not refused (D-17, 01 D-15).
  reportSectionLint(
    input.hooks,
    lintSectionProperties(blocks),
    () => new Date(),
  );

  return Object.freeze({
    content: input.content,
    blocks,
    sectionNestingDepth,
    blockDepthCeiling,
  });
}

/** Emitted at boot when a locale present in stored pages/blocks is no
 * longer in `ContentConfig.locales` (D-37, plan 04-11 or later). */
export type LocaleRemovedEvent = {
  readonly locale: string;
  readonly pageCount: number;
  readonly occurredAt: Date;
};

export type PagesHooks = {
  readonly onDegradedBlock?: (event: DegradedBlockEvent) => void;
  readonly onSectionLint?: (event: SectionLintEvent) => void;
  readonly onBelowFloor?: (event: BelowFloorEvent) => void;
  readonly onLocaleRemoved?: (event: LocaleRemovedEvent) => void;
  /** Forwarded to `registerHostFieldType` (EXT-02, D-05): fires when a
   * host `fieldTypes` entry shadows one of `@plakboek/content`'s sixteen
   * built-in field types -- shadowing is permitted, never silent. */
  readonly onShadowedFieldType?: (event: ShadowedFieldTypeEvent) => void;
};

/** Every engine operation's dependency bag: the database handle, the
 * audited-mutation recorder, the permission resolver, the validated pages
 * config, optional warning hooks, and an injectable clock (defaults to
 * `() => new Date()`). */
export type PagesDeps = {
  readonly db: AuditDatabase;
  readonly recorder: AuditRecorder;
  readonly resolver: PermissionResolver;
  readonly config: PagesConfig;
  readonly hooks?: PagesHooks;
  readonly now?: () => Date;
};
