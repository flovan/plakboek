/**
 * Block layout: the values the editor's layout controls write, kept apart
 * from `props` (D-33). A section carries a column ratio preset and a
 * vertical alignment; a block that declares fill support carries a fill
 * flag; a column carries nothing. Layout is validated on every write against
 * the registered block definition and the configured column presets, so what
 * reaches a visitor's stylesheet is always a known preset string or one of
 * four alignment keywords, never free text (D-04, D-05, D-08).
 *
 * Presets are a validated configuration list, not stored identifiers: a host
 * adding or excluding a preset changes what a NEW write may store, never how
 * an already stored layout reads. No column count is stored anywhere; it is
 * derived from the section's column children, and an equal split is stored
 * as an absent `columns` value.
 */
import type { BlockDefinition } from './registry.js';

export const COLUMN_ALIGN_VALUES = Object.freeze([
  'stretch',
  'start',
  'center',
  'end',
] as const);
export type ColumnAlign = (typeof COLUMN_ALIGN_VALUES)[number];

/** A section's layout (`columns`, `align`) or a fill-capable block's
 * (`fill`). Every key is optional; an absent key means the default. */
export type BlockLayout = {
  readonly columns?: string;
  readonly align?: ColumnAlign;
  readonly fill?: boolean;
};

/** The built-in ratio presets. An equal split is always allowed for any
 * column count, so the equal entries here exist only so they can be listed;
 * they are never stored. */
export const BUILT_IN_COLUMN_PRESETS = Object.freeze([
  '1',
  '1:1',
  '2:1',
  '1:2',
  '1:1:1',
  '2:1:1',
  '1:2:1',
  '1:1:2',
  '1:1:1:1',
] as const);

/** Colon-separated positive integer terms, each at most three digits, at
 * most 64 terms. The only shape a ratio may take, so a ratio can never carry
 * anything but digits and colons into a stylesheet. */
export const COLUMN_RATIO_PATTERN = /^[1-9]\d{0,2}(?::[1-9]\d{0,2}){0,63}$/;

export type ColumnPresetsInput = {
  readonly exclude?: readonly string[];
  readonly add?: readonly string[];
};

function ratioTerms(ratio: string): readonly string[] {
  return ratio.split(':');
}

/** True for a ratio whose terms are all equal (`1`, `1:1`, `2:2:2`): the
 * equal split, which is stored as an absent `columns` value. */
export function isEqualRatio(ratio: string): boolean {
  const terms = ratioTerms(ratio);
  const [first] = terms;
  return terms.every((term) => term === first);
}

function isBuiltInPreset(ratio: string): boolean {
  return BUILT_IN_COLUMN_PRESETS.some((preset) => preset === ratio);
}

/**
 * Resolves the configured preset list: the built-ins minus the excluded
 * ones, then the added ones, in order. Equal splits can neither be excluded
 * (they are always allowed) nor added (they are never stored). Returns every
 * problem found rather than throwing; `definePagesConfig` turns them into a
 * `PagesConfigError`.
 */
export function resolveColumnPresets(input?: ColumnPresetsInput): {
  readonly presets: readonly string[];
  readonly issues: readonly string[];
} {
  const issues: string[] = [];
  const excluded = new Set<string>();
  for (const entry of input?.exclude ?? []) {
    if (typeof entry !== 'string' || !COLUMN_RATIO_PATTERN.test(entry)) {
      issues.push(
        `columnPresets.exclude entry ${JSON.stringify(entry)} is not a ratio`,
      );
      continue;
    }
    if (!isBuiltInPreset(entry)) {
      issues.push(`columnPresets.exclude "${entry}" is not a built-in preset`);
      continue;
    }
    if (isEqualRatio(entry)) {
      issues.push(
        `columnPresets.exclude "${entry}" is an equal split, which is always allowed`,
      );
      continue;
    }
    excluded.add(entry);
  }

  const added: string[] = [];
  for (const entry of input?.add ?? []) {
    if (typeof entry !== 'string' || !COLUMN_RATIO_PATTERN.test(entry)) {
      issues.push(
        `columnPresets.add entry ${JSON.stringify(entry)} is not a ratio`,
      );
      continue;
    }
    if (isEqualRatio(entry)) {
      issues.push(
        `columnPresets.add "${entry}" is an equal split, which is always allowed`,
      );
      continue;
    }
    if (isBuiltInPreset(entry) || added.includes(entry)) {
      issues.push(`columnPresets.add "${entry}" duplicates an existing preset`);
      continue;
    }
    added.push(entry);
  }

  const presets = [
    ...BUILT_IN_COLUMN_PRESETS.filter((preset) => !excluded.has(preset)),
    ...added,
  ];
  return { presets: Object.freeze(presets), issues: Object.freeze(issues) };
}

export type BlockLayoutValidationIssueCode = 'UNKNOWN' | 'INVALID';

export type BlockLayoutValidationIssue = {
  readonly key: string;
  readonly code: BlockLayoutValidationIssueCode;
};

/** Thrown by `validateBlockLayout`, naming every failing key and code only
 * -- never the submitted value. */
export class BlockLayoutValidationError extends Error {
  readonly issues: readonly BlockLayoutValidationIssue[];

  constructor(issues: readonly BlockLayoutValidationIssue[]) {
    super(
      [
        '[@plakboek/pages] invalid block layout:',
        ...issues.map((issue) => `"${issue.key}": ${issue.code}`),
      ].join('\n'),
    );
    this.name = 'BlockLayoutValidationError';
    this.issues = issues;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isColumnAlign(value: unknown): value is ColumnAlign {
  return COLUMN_ALIGN_VALUES.some((align) => align === value);
}

/**
 * Validates a layout value for `definition` against `presets` and returns
 * its normalised form: an equal ratio, `stretch` and `fill: false` are
 * absent, and an empty result is `null`. A section accepts `columns` and
 * `align`; a block accepts `fill` only when its definition declares fill
 * support; a column accepts nothing. Collects every issue before throwing one
 * `BlockLayoutValidationError`. Internal, like `validateBlockProps`: it is
 * reachable only through the write paths and `previewBlockValues`.
 */
export function validateBlockLayout(
  definition: BlockDefinition,
  layout: unknown,
  presets: readonly string[],
): BlockLayout | null {
  if (layout === null || layout === undefined) return null;
  if (!isPlainObject(layout)) {
    throw new BlockLayoutValidationError([{ key: '*', code: 'INVALID' }]);
  }

  const issues: BlockLayoutValidationIssue[] = [];
  let columns: string | undefined;
  let align: ColumnAlign | undefined;
  let fill: boolean | undefined;

  for (const [key, value] of Object.entries(layout)) {
    if (key === 'columns' && definition.kind === 'section') {
      if (value === undefined) continue;
      if (typeof value !== 'string' || !COLUMN_RATIO_PATTERN.test(value)) {
        issues.push({ key, code: 'INVALID' });
      } else if (isEqualRatio(value)) {
        columns = undefined;
      } else if (presets.includes(value)) {
        columns = value;
      } else {
        issues.push({ key, code: 'INVALID' });
      }
      continue;
    }
    if (key === 'align' && definition.kind === 'section') {
      if (value === undefined) continue;
      if (!isColumnAlign(value)) {
        issues.push({ key, code: 'INVALID' });
      } else if (value !== 'stretch') {
        align = value;
      }
      continue;
    }
    if (
      key === 'fill' &&
      definition.kind === 'block' &&
      definition.layoutSupport.fill
    ) {
      if (value === undefined) continue;
      if (typeof value !== 'boolean') {
        issues.push({ key, code: 'INVALID' });
      } else if (value) {
        fill = true;
      }
      continue;
    }
    issues.push({ key, code: 'UNKNOWN' });
  }

  if (issues.length > 0) {
    throw new BlockLayoutValidationError(issues);
  }

  const result: { columns?: string; align?: ColumnAlign; fill?: boolean } = {};
  if (columns !== undefined) result.columns = columns;
  if (align !== undefined) result.align = align;
  if (fill !== undefined) result.fill = fill;
  return Object.keys(result).length === 0 ? null : Object.freeze(result);
}

/**
 * Reads a stored `layout` column value back into a `BlockLayout`, keeping
 * only the keys and values this package writes. A stored value is validated
 * on write, so this is a narrowing, not a second validation: anything that is
 * not a plain object, or carries a value of the wrong shape, reads as absent.
 * Reads never consult the configured presets, so a host changing its presets
 * never changes how an already stored layout reads.
 */
export function readStoredLayout(value: unknown): BlockLayout | null {
  if (!isPlainObject(value)) return null;
  const result: { columns?: string; align?: ColumnAlign; fill?: boolean } = {};
  const { columns, align, fill } = value;
  if (typeof columns === 'string') result.columns = columns;
  if (isColumnAlign(align)) result.align = align;
  if (fill === true) result.fill = true;
  return Object.keys(result).length === 0 ? null : Object.freeze(result);
}
