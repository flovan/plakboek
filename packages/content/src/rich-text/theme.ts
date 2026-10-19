/**
 * The text theme: one plain data value that says which marks, nodes, heading
 * levels, palettes and alignment a rich-text field accepts. It is data, not
 * behaviour, so the server validator, the editor's schema builder and the
 * renderer can all be driven from the same value.
 */
import { TOKEN_PATTERN } from './values.js';

export const TEXT_MARK_NAMES = [
  'bold',
  'italic',
  'underline',
  'strike',
  'link',
] as const;

/**
 * The optional nodes. Paragraph, doc, text and listItem are structural and
 * always present (listItem exists whenever either list does).
 */
export const TEXT_NODE_NAMES = [
  'bulletList',
  'orderedList',
  'blockquote',
  'horizontalRule',
  'hardBreak',
  'cta',
] as const;

/** Level 1 is never available: the page title owns it. */
export const HEADING_LEVELS = [2, 3, 4] as const;

export const TEXT_ALIGNS = ['left', 'center', 'right'] as const;

export type TextMarkName = (typeof TEXT_MARK_NAMES)[number];
export type TextNodeName = (typeof TEXT_NODE_NAMES)[number];
export type HeadingLevel = (typeof HEADING_LEVELS)[number];
export type TextAlign = (typeof TEXT_ALIGNS)[number];

/** One colour of the palette: the label an editor sees and the token stored. */
export type TextPaletteEntry = {
  readonly label: string;
  readonly token: string;
};

/** One size of the palette; `value` is an optional px size for the editor. */
export type TextSizeEntry = {
  readonly label: string;
  readonly token: string;
  readonly value?: string;
};

/** One look a CTA button can take: the label an editor sees and the key stored. */
export type CtaVariant = {
  readonly label: string;
  readonly value: string;
};

export type TextThemeInput = {
  readonly marks?: readonly TextMarkName[];
  readonly nodes?: readonly TextNodeName[];
  readonly headingLevels?: readonly HeadingLevel[];
  readonly colors?: readonly TextPaletteEntry[];
  readonly sizes?: readonly TextSizeEntry[];
  readonly align?: boolean;
  readonly allowCustomValues?: boolean;
  readonly ctaVariants?: readonly CtaVariant[];
};

export type TextTheme = {
  readonly marks: readonly TextMarkName[];
  readonly nodes: readonly TextNodeName[];
  readonly headingLevels: readonly HeadingLevel[];
  readonly colors: readonly TextPaletteEntry[];
  readonly sizes: readonly TextSizeEntry[];
  readonly align: boolean;
  readonly allowCustomValues: boolean;
  readonly ctaVariants: readonly CtaVariant[];
};

export type TextThemeIssueCode =
  | 'INVALID_SHAPE'
  | 'UNKNOWN_MARK'
  | 'UNKNOWN_NODE'
  | 'INVALID_HEADING_LEVEL'
  | 'DUPLICATE_NAME'
  | 'INVALID_LABEL'
  | 'INVALID_TOKEN'
  | 'DUPLICATE_TOKEN'
  | 'INVALID_SIZE_VALUE'
  | 'CTA_WITHOUT_VARIANTS';

export type TextThemeIssue = {
  readonly code: TextThemeIssueCode;
  readonly message: string;
};

/** Thrown by `resolveTextTheme` with every problem found, not only the first. */
export class TextThemeError extends Error {
  readonly issues: readonly TextThemeIssue[];

  constructor(issues: readonly TextThemeIssue[]) {
    super(
      `Invalid text theme: ${issues.map((issue) => issue.message).join('; ')}`,
    );
    this.name = 'TextThemeError';
    this.issues = issues;
  }
}

function freezeEntries<T extends object>(
  entries: readonly T[],
): readonly Readonly<T>[] {
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}

export const DEFAULT_TEXT_THEME: TextTheme = Object.freeze({
  marks: Object.freeze([...TEXT_MARK_NAMES]),
  nodes: Object.freeze([...TEXT_NODE_NAMES]),
  headingLevels: Object.freeze([...HEADING_LEVELS]),
  colors: Object.freeze([]),
  sizes: Object.freeze([]),
  align: false,
  allowCustomValues: true,
  ctaVariants: freezeEntries([
    { label: 'Primary', value: 'primary' },
    { label: 'Secondary', value: 'secondary' },
  ]),
});

const LABEL_MAX_LENGTH = 80;
const MESSAGE_VALUE_MAX_LENGTH = 64;
const SIZE_VALUE_PATTERN = /^\d+(?:\.\d+)?px$/;

/** A developer-supplied value as it may appear in an error message. */
function shown(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  let printable = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    printable +=
      code < 0x20 || (code >= 0x7f && code <= 0x9f) ? '?' : character;
  }
  return printable.length > MESSAGE_VALUE_MAX_LENGTH
    ? `${printable.slice(0, MESSAGE_VALUE_MAX_LENGTH)}...`
    : printable;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlankOrTooLong(label: unknown): boolean {
  return (
    typeof label !== 'string' ||
    label.trim().length === 0 ||
    label.length > LABEL_MAX_LENGTH
  );
}

function checkNameList<T extends string>(
  key: string,
  value: unknown,
  known: readonly T[],
  unknownCode: 'UNKNOWN_MARK' | 'UNKNOWN_NODE',
  issues: TextThemeIssue[],
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push({ code: 'INVALID_SHAPE', message: `${key} must be a list` });
    return undefined;
  }
  const seen = new Set<string>();
  const accepted: T[] = [];
  for (const name of value as unknown[]) {
    if (
      typeof name !== 'string' ||
      !(known as readonly string[]).includes(name)
    ) {
      issues.push({
        code: unknownCode,
        message: `${key} names "${shown(name)}", which is not one of ${known.join(', ')}`,
      });
      continue;
    }
    if (seen.has(name)) {
      issues.push({
        code: 'DUPLICATE_NAME',
        message: `${key} lists "${name}" more than once`,
      });
      continue;
    }
    seen.add(name);
    accepted.push(name as T);
  }
  return accepted;
}

function checkHeadingLevels(
  value: unknown,
  issues: TextThemeIssue[],
): readonly HeadingLevel[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push({
      code: 'INVALID_SHAPE',
      message: 'headingLevels must be a list',
    });
    return undefined;
  }
  const seen = new Set<number>();
  const accepted: HeadingLevel[] = [];
  for (const level of value as unknown[]) {
    if (
      typeof level !== 'number' ||
      !(HEADING_LEVELS as readonly number[]).includes(level)
    ) {
      issues.push({
        code: 'INVALID_HEADING_LEVEL',
        message: `headingLevels names "${shown(level)}", but only levels ${HEADING_LEVELS.join(', ')} exist (level 1 belongs to the page title)`,
      });
      continue;
    }
    if (seen.has(level)) {
      issues.push({
        code: 'DUPLICATE_NAME',
        message: `headingLevels lists ${level} more than once`,
      });
      continue;
    }
    seen.add(level);
    accepted.push(level as HeadingLevel);
  }
  return accepted;
}

function checkPalette<T extends TextPaletteEntry | TextSizeEntry>(
  key: 'colors' | 'sizes',
  value: unknown,
  withSizeValue: boolean,
  issues: TextThemeIssue[],
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push({ code: 'INVALID_SHAPE', message: `${key} must be a list` });
    return undefined;
  }
  const seen = new Set<string>();
  const accepted: T[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) {
      issues.push({
        code: 'INVALID_SHAPE',
        message: `${key} holds an entry that is not an object`,
      });
      continue;
    }
    let valid = true;
    if (isBlankOrTooLong(entry.label)) {
      issues.push({
        code: 'INVALID_LABEL',
        message: `${key} entry "${shown(entry.token)}" needs a label of 1 to ${LABEL_MAX_LENGTH} characters`,
      });
      valid = false;
    }
    const token = entry.token;
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      issues.push({
        code: 'INVALID_TOKEN',
        message: `${key} token "${shown(token)}" must be lowercase letters, digits and dashes, starting with a letter`,
      });
      valid = false;
    } else if (seen.has(token)) {
      issues.push({
        code: 'DUPLICATE_TOKEN',
        message: `${key} token "${token}" is listed more than once`,
      });
      valid = false;
    }
    if (
      withSizeValue &&
      entry.value !== undefined &&
      (typeof entry.value !== 'string' || !SIZE_VALUE_PATTERN.test(entry.value))
    ) {
      issues.push({
        code: 'INVALID_SIZE_VALUE',
        message: `sizes entry "${shown(token)}" has value "${shown(entry.value)}", which is not a px size such as 18px`,
      });
      valid = false;
    }
    if (typeof token === 'string') seen.add(token);
    if (valid) {
      accepted.push(
        (withSizeValue && typeof entry.value === 'string'
          ? { label: entry.label, token, value: entry.value }
          : { label: entry.label, token }) as T,
      );
    }
  }
  return accepted;
}

function checkCtaVariants(
  value: unknown,
  issues: TextThemeIssue[],
): readonly CtaVariant[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push({
      code: 'INVALID_SHAPE',
      message: 'ctaVariants must be a list',
    });
    return undefined;
  }
  const seen = new Set<string>();
  const accepted: CtaVariant[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) {
      issues.push({
        code: 'INVALID_SHAPE',
        message: 'ctaVariants holds an entry that is not an object',
      });
      continue;
    }
    let valid = true;
    if (isBlankOrTooLong(entry.label)) {
      issues.push({
        code: 'INVALID_LABEL',
        message: `ctaVariants entry "${shown(entry.value)}" needs a label of 1 to ${LABEL_MAX_LENGTH} characters`,
      });
      valid = false;
    }
    const variant = entry.value;
    if (typeof variant !== 'string' || !TOKEN_PATTERN.test(variant)) {
      issues.push({
        code: 'INVALID_TOKEN',
        message: `ctaVariants value "${shown(variant)}" must be lowercase letters, digits and dashes, starting with a letter`,
      });
      valid = false;
    } else if (seen.has(variant)) {
      issues.push({
        code: 'DUPLICATE_TOKEN',
        message: `ctaVariants value "${variant}" is listed more than once`,
      });
      valid = false;
    }
    if (typeof variant === 'string') seen.add(variant);
    if (valid) {
      accepted.push({ label: entry.label as string, value: variant as string });
    }
  }
  return accepted;
}

function checkFlag(
  key: 'align' | 'allowCustomValues',
  value: unknown,
  issues: TextThemeIssue[],
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    issues.push({
      code: 'INVALID_SHAPE',
      message: `${key} must be true or false`,
    });
    return undefined;
  }
  return value;
}

/**
 * Fill a theme from its defaults, check it and freeze it. Every problem is
 * collected before `TextThemeError` is thrown, so a developer fixes a theme
 * in one pass. Messages quote at most 64 printable characters of the value.
 */
export function resolveTextTheme(input?: TextThemeInput): TextTheme {
  if (input !== undefined && !isRecord(input)) {
    throw new TextThemeError([
      { code: 'INVALID_SHAPE', message: 'the theme must be an object' },
    ]);
  }
  const source: Record<string, unknown> = input ?? {};
  const issues: TextThemeIssue[] = [];

  const marks = checkNameList(
    'marks',
    source.marks,
    TEXT_MARK_NAMES,
    'UNKNOWN_MARK',
    issues,
  );
  const nodes = checkNameList(
    'nodes',
    source.nodes,
    TEXT_NODE_NAMES,
    'UNKNOWN_NODE',
    issues,
  );
  const headingLevels = checkHeadingLevels(source.headingLevels, issues);
  const colors = checkPalette<TextPaletteEntry>(
    'colors',
    source.colors,
    false,
    issues,
  );
  const sizes = checkPalette<TextSizeEntry>(
    'sizes',
    source.sizes,
    true,
    issues,
  );
  const align = checkFlag('align', source.align, issues);
  const allowCustomValues = checkFlag(
    'allowCustomValues',
    source.allowCustomValues,
    issues,
  );
  const ctaVariants = checkCtaVariants(source.ctaVariants, issues);

  const effectiveNodes = nodes ?? DEFAULT_TEXT_THEME.nodes;
  const effectiveVariants = ctaVariants ?? DEFAULT_TEXT_THEME.ctaVariants;
  if (effectiveNodes.includes('cta') && effectiveVariants.length === 0) {
    issues.push({
      code: 'CTA_WITHOUT_VARIANTS',
      message:
        'the cta node needs at least one variant; list a variant or remove cta from nodes',
    });
  }

  if (issues.length > 0) throw new TextThemeError(issues);

  return Object.freeze({
    marks: Object.freeze([...(marks ?? DEFAULT_TEXT_THEME.marks)]),
    nodes: Object.freeze([...effectiveNodes]),
    headingLevels: Object.freeze([
      ...(headingLevels ?? DEFAULT_TEXT_THEME.headingLevels),
    ]),
    colors: freezeEntries(colors ?? DEFAULT_TEXT_THEME.colors),
    sizes: freezeEntries(sizes ?? DEFAULT_TEXT_THEME.sizes),
    align: align ?? DEFAULT_TEXT_THEME.align,
    allowCustomValues:
      allowCustomValues ?? DEFAULT_TEXT_THEME.allowCustomValues,
    ctaVariants: freezeEntries(effectiveVariants),
  });
}
