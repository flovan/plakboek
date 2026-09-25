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
import type { BlockDefinition } from './registry.js';

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

  return Object.freeze({
    content: input.content,
    blocks,
    sectionNestingDepth,
    blockDepthCeiling,
  });
}

/** Emitted when `readBlockTree`/`upcastOnRead` cannot bring a stored
 * block's props to its registry's current shape (D-12, D-15). The row is
 * never rewritten or dropped because of it; plan 04-07 wires this hook into
 * `readBlockTree`. */
export type BlockDegradedEvent = {
  readonly ownerType: string;
  readonly ownerId: string;
  readonly locale: string;
  readonly blockId: string;
  readonly blockType: string;
  readonly reason: string;
  readonly occurredAt: Date;
};

/** Emitted by the D-17 boot-time section lint (plan 04-05); never thrown. */
export type SectionLintEvent = {
  readonly blockType: string;
  readonly propertyKey: string;
  readonly fieldType: string;
  readonly occurredAt: Date;
};

/** Emitted at boot when a locale present in stored pages/blocks is no
 * longer in `ContentConfig.locales` (D-37, plan 04-11 or later). */
export type LocaleRemovedEvent = {
  readonly locale: string;
  readonly pageCount: number;
  readonly occurredAt: Date;
};

export type PagesHooks = {
  readonly onDegradedBlock?: (event: BlockDegradedEvent) => void;
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

/**
 * Invokes a warning hook (or its fallback) inside a try/catch, handling a
 * hook that returns a rejected promise the same way
 * `@plakboek/content`'s `reportContentWarning` does -- a broken or slow
 * host-supplied hook can never crash the operation it is reporting on.
 */
export function reportPagesWarning<E>(
  hook: ((event: E) => void) | undefined,
  fallback: (event: E) => void,
  event: E,
): void {
  const invoke = hook ?? fallback;
  try {
    const returned: unknown = invoke(event);
    if (
      typeof returned === 'object' &&
      returned !== null &&
      typeof Reflect.get(returned, 'then') === 'function'
    ) {
      void Promise.resolve(returned).catch((hookError: unknown) => {
        logHookFailure(hookError);
      });
    }
  } catch (hookError) {
    logHookFailure(hookError);
  }
}

function logHookFailure(hookError: unknown): void {
  try {
    // oxlint-disable-next-line no-console -- last-resort fallback when a host-supplied pages warning hook itself throws or rejects
    console.error('[@plakboek/pages] a warning hook threw', hookError);
  } catch {
    // Never let a broken console/logger escape either.
  }
}
