/**
 * The allowed-set validator for stored rich-text documents. One pure module
 * decides what a document may contain for a given theme, so the server, the
 * editor's schema and the renderer share a single set of acceptance rules.
 * Issues carry a path and a code, never the submitted value.
 */
import { isAllowedHref } from './href.js';
import { isCompleteLinkTarget, PAGE_ID_PATTERN } from './link.js';
import { TEXT_ALIGNS, type TextTheme } from './theme.js';
import {
  isCustomColorValue,
  isCustomSizeValue,
  TOKEN_PATTERN,
} from './values.js';

export type RichTextMarkJson = {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
};

export type RichTextNodeJson = {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly RichTextNodeJson[];
  readonly marks?: readonly RichTextMarkJson[];
  readonly text?: string;
};

export type RichTextDocument = {
  readonly type: 'doc';
  readonly content?: readonly RichTextNodeJson[];
};

export type RichTextIssueCode =
  | 'INVALID_SHAPE'
  | 'UNKNOWN_NODE'
  | 'UNKNOWN_MARK'
  | 'NODE_NOT_ALLOWED'
  | 'MARK_NOT_ALLOWED'
  | 'ATTRIBUTE_NOT_ALLOWED'
  | 'INVALID_CONTENT'
  | 'INVALID_HREF'
  | 'INVALID_TOKEN'
  | 'CUSTOM_VALUE_NOT_ALLOWED'
  | 'TOO_DEEP';

export type RichTextIssue = {
  readonly path: string;
  readonly code: RichTextIssueCode;
};

/** The doc counts as depth 1, matching the field type's own depth cap. */
const MAX_DEPTH = 32;
const MAX_ISSUES = 100;
const CTA_LABEL_MAX_LENGTH = 200;
const ORDERED_LIST_START_MAX = 1_000_000;

/** Every node name this module knows, wherever it may legally sit. */
const KNOWN_NODE_TYPES: readonly string[] = [
  'doc',
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'horizontalRule',
  'hardBreak',
  'cta',
  'text',
];

type Context = {
  readonly theme: TextTheme;
  readonly issues: RichTextIssue[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function join(path: string, key: string | number): string {
  return path === '' ? String(key) : `${path}.${key}`;
}

function report(context: Context, path: string, code: RichTextIssueCode): void {
  if (context.issues.length < MAX_ISSUES) context.issues.push({ path, code });
}

/** Refuse every key of `value` that is not in `allowed`. */
function checkKeys(
  context: Context,
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      report(context, join(path, key), 'INVALID_SHAPE');
    }
  }
}

/**
 * The attrs object of a node or mark: absent, or an object limited to
 * `allowed`. Returns it (an empty object when absent) or null after
 * reporting a shape problem.
 */
function readAttrs(
  context: Context,
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): Record<string, unknown> | null {
  const attrs = value.attrs;
  if (attrs === undefined) return {};
  const attrsPath = join(path, 'attrs');
  if (!isRecord(attrs)) {
    report(context, attrsPath, 'INVALID_SHAPE');
    return null;
  }
  checkKeys(context, attrs, allowed, attrsPath);
  return attrs;
}

/** A node or mark that declares no attributes. */
function checkNoAttrs(
  context: Context,
  value: Record<string, unknown>,
  path: string,
): void {
  readAttrs(context, value, [], path);
}

/** href, pageId and target of a link or CTA, with the shared href policy. */
function checkLinkTarget(
  context: Context,
  attrs: Record<string, unknown>,
  attrsPath: string,
  requireTarget: boolean,
): void {
  const { href, pageId, target } = attrs;
  const hrefSet = isSet(href);
  const pageIdSet = isSet(pageId);

  if (hrefSet) {
    if (typeof href !== 'string') {
      report(context, join(attrsPath, 'href'), 'INVALID_SHAPE');
    } else if (!isAllowedHref(href)) {
      report(context, join(attrsPath, 'href'), 'INVALID_HREF');
    }
  }
  if (pageIdSet) {
    if (typeof pageId !== 'string') {
      report(context, join(attrsPath, 'pageId'), 'INVALID_SHAPE');
    } else if (!PAGE_ID_PATTERN.test(pageId)) {
      report(context, join(attrsPath, 'pageId'), 'INVALID_HREF');
    }
  }
  if (hrefSet && pageIdSet) report(context, attrsPath, 'INVALID_SHAPE');
  if (requireTarget && !hrefSet && !pageIdSet) {
    report(context, attrsPath, 'INVALID_SHAPE');
  }
  if (isSet(target) && target !== '_blank') {
    report(context, join(attrsPath, 'target'), 'INVALID_SHAPE');
  }
}

/** token and value of a colour or size mark: exactly one, checked against the theme. */
function checkPaletteValue(
  context: Context,
  attrs: Record<string, unknown>,
  attrsPath: string,
  tokens: readonly string[],
  isLiteral: (value: string) => boolean,
): void {
  const { token, value } = attrs;
  const tokenSet = isSet(token);
  const valueSet = isSet(value);
  if (tokenSet === valueSet) report(context, attrsPath, 'INVALID_SHAPE');

  if (tokenSet) {
    if (typeof token !== 'string') {
      report(context, join(attrsPath, 'token'), 'INVALID_SHAPE');
    } else if (!TOKEN_PATTERN.test(token) || !tokens.includes(token)) {
      report(context, join(attrsPath, 'token'), 'INVALID_TOKEN');
    }
  }
  if (valueSet) {
    if (typeof value !== 'string') {
      report(context, join(attrsPath, 'value'), 'INVALID_SHAPE');
    } else if (!context.theme.allowCustomValues) {
      report(context, join(attrsPath, 'value'), 'CUSTOM_VALUE_NOT_ALLOWED');
    } else if (!isLiteral(value)) {
      report(context, join(attrsPath, 'value'), 'INVALID_SHAPE');
    }
  }
}

function validateMark(
  context: Context,
  mark: Record<string, unknown>,
  type: string,
  path: string,
): void {
  const { theme } = context;
  switch (type) {
    case 'bold':
    case 'italic':
    case 'underline':
    case 'strike':
      if (!theme.marks.includes(type)) {
        report(context, path, 'MARK_NOT_ALLOWED');
        return;
      }
      checkNoAttrs(context, mark, path);
      return;
    case 'link': {
      if (!theme.marks.includes('link')) {
        report(context, path, 'MARK_NOT_ALLOWED');
        return;
      }
      const attrs = readAttrs(
        context,
        mark,
        ['href', 'pageId', 'target'],
        path,
      );
      if (attrs !== null) {
        checkLinkTarget(context, attrs, join(path, 'attrs'), true);
      }
      return;
    }
    case 'textColor': {
      if (theme.colors.length === 0) {
        report(context, path, 'MARK_NOT_ALLOWED');
        return;
      }
      const attrs = readAttrs(context, mark, ['token', 'value'], path);
      if (attrs !== null) {
        checkPaletteValue(
          context,
          attrs,
          join(path, 'attrs'),
          theme.colors.map((entry) => entry.token),
          isCustomColorValue,
        );
      }
      return;
    }
    case 'textSize': {
      if (theme.sizes.length === 0) {
        report(context, path, 'MARK_NOT_ALLOWED');
        return;
      }
      const attrs = readAttrs(context, mark, ['token', 'value'], path);
      if (attrs !== null) {
        checkPaletteValue(
          context,
          attrs,
          join(path, 'attrs'),
          theme.sizes.map((entry) => entry.token),
          isCustomSizeValue,
        );
      }
      return;
    }
    default:
      report(context, path, 'UNKNOWN_MARK');
  }
}

function validateMarks(
  context: Context,
  node: Record<string, unknown>,
  path: string,
): void {
  const marks = node.marks;
  if (marks === undefined) return;
  const marksPath = join(path, 'marks');
  if (!Array.isArray(marks)) {
    report(context, marksPath, 'INVALID_SHAPE');
    return;
  }
  const seen = new Set<string>();
  marks.forEach((mark: unknown, index) => {
    const markPath = join(marksPath, index);
    if (!isRecord(mark)) {
      report(context, markPath, 'INVALID_SHAPE');
      return;
    }
    checkKeys(context, mark, ['type', 'attrs'], markPath);
    const type = mark.type;
    if (typeof type !== 'string') {
      report(context, join(markPath, 'type'), 'INVALID_SHAPE');
      return;
    }
    if (seen.has(type)) {
      report(context, markPath, 'INVALID_CONTENT');
      return;
    }
    seen.add(type);
    validateMark(context, mark, type, markPath);
  });
}

function validateText(
  context: Context,
  node: Record<string, unknown>,
  path: string,
): void {
  checkKeys(context, node, ['type', 'text', 'marks'], path);
  if (typeof node.text !== 'string' || node.text.length === 0) {
    report(context, join(path, 'text'), 'INVALID_SHAPE');
  }
  validateMarks(context, node, path);
}

function validateInline(
  context: Context,
  content: unknown,
  path: string,
  depth: number,
): void {
  if (content === undefined) return;
  const contentPath = join(path, 'content');
  if (!Array.isArray(content)) {
    report(context, contentPath, 'INVALID_SHAPE');
    return;
  }
  content.forEach((child: unknown, index) => {
    const childPath = join(contentPath, index);
    if (depth + 1 > MAX_DEPTH) {
      report(context, childPath, 'TOO_DEEP');
      return;
    }
    if (!isRecord(child) || typeof child.type !== 'string') {
      report(context, childPath, 'INVALID_SHAPE');
      return;
    }
    if (child.type === 'text') {
      validateText(context, child, childPath);
    } else if (child.type === 'hardBreak') {
      if (!context.theme.nodes.includes('hardBreak')) {
        report(context, childPath, 'NODE_NOT_ALLOWED');
        return;
      }
      checkKeys(context, child, ['type', 'attrs'], childPath);
      checkNoAttrs(context, child, childPath);
    } else {
      report(
        context,
        childPath,
        KNOWN_NODE_TYPES.includes(child.type)
          ? 'NODE_NOT_ALLOWED'
          : 'UNKNOWN_NODE',
      );
    }
  });
}

/** textAlign: null or omitted always; a value only when the theme has alignment. */
function checkTextAlign(
  context: Context,
  attrs: Record<string, unknown>,
  attrsPath: string,
): void {
  const align = attrs.textAlign;
  if (!isSet(align)) return;
  const alignPath = join(attrsPath, 'textAlign');
  if (
    typeof align !== 'string' ||
    !(TEXT_ALIGNS as readonly string[]).includes(align)
  ) {
    report(context, alignPath, 'INVALID_SHAPE');
  } else if (!context.theme.align) {
    report(context, alignPath, 'ATTRIBUTE_NOT_ALLOWED');
  }
}

function validateParagraph(
  context: Context,
  node: Record<string, unknown>,
  path: string,
  depth: number,
): void {
  checkKeys(context, node, ['type', 'attrs', 'content'], path);
  const attrs = readAttrs(context, node, ['textAlign'], path);
  if (attrs !== null) checkTextAlign(context, attrs, join(path, 'attrs'));
  validateInline(context, node.content, path, depth);
}

function validateHeading(
  context: Context,
  node: Record<string, unknown>,
  path: string,
  depth: number,
): void {
  checkKeys(context, node, ['type', 'attrs', 'content'], path);
  const attrs = readAttrs(context, node, ['level', 'textAlign'], path);
  if (attrs === null) return;
  const attrsPath = join(path, 'attrs');
  const level = attrs.level;
  if (typeof level !== 'number' || !Number.isInteger(level)) {
    report(context, join(attrsPath, 'level'), 'INVALID_SHAPE');
    return;
  }
  if (!(context.theme.headingLevels as readonly number[]).includes(level)) {
    report(context, path, 'NODE_NOT_ALLOWED');
    return;
  }
  checkTextAlign(context, attrs, attrsPath);
  validateInline(context, node.content, path, depth);
}

/** A leaf block (divider, CTA) holds no content. */
function checkLeafContent(
  context: Context,
  node: Record<string, unknown>,
  path: string,
): void {
  const content = node.content;
  if (content === undefined) return;
  if (!Array.isArray(content)) {
    report(context, join(path, 'content'), 'INVALID_SHAPE');
  } else if (content.length > 0) {
    report(context, join(path, 'content'), 'INVALID_CONTENT');
  }
}

function validateCta(
  context: Context,
  node: Record<string, unknown>,
  path: string,
): void {
  checkKeys(context, node, ['type', 'attrs', 'content'], path);
  checkLeafContent(context, node, path);
  const attrs = readAttrs(
    context,
    node,
    ['label', 'href', 'pageId', 'target', 'variant'],
    path,
  );
  if (attrs === null) return;
  const attrsPath = join(path, 'attrs');
  const { label, variant } = attrs;
  if (
    isSet(label) &&
    (typeof label !== 'string' || label.length > CTA_LABEL_MAX_LENGTH)
  ) {
    report(context, join(attrsPath, 'label'), 'INVALID_SHAPE');
  }
  checkLinkTarget(context, attrs, attrsPath, false);
  if (isSet(variant)) {
    if (typeof variant !== 'string') {
      report(context, join(attrsPath, 'variant'), 'INVALID_SHAPE');
    } else if (
      !context.theme.ctaVariants.some((entry) => entry.value === variant)
    ) {
      report(context, join(attrsPath, 'variant'), 'INVALID_TOKEN');
    }
  }
}

function validateBlockList(
  context: Context,
  content: unknown,
  path: string,
  depth: number,
  firstMustBeParagraph: boolean,
): void {
  const contentPath = join(path, 'content');
  if (content === undefined) {
    report(context, contentPath, 'INVALID_CONTENT');
    return;
  }
  if (!Array.isArray(content)) {
    report(context, contentPath, 'INVALID_SHAPE');
    return;
  }
  if (content.length === 0) {
    report(context, contentPath, 'INVALID_CONTENT');
    return;
  }
  content.forEach((child: unknown, index) => {
    const childPath = join(contentPath, index);
    if (
      firstMustBeParagraph &&
      index === 0 &&
      isRecord(child) &&
      typeof child.type === 'string' &&
      child.type !== 'paragraph'
    ) {
      report(context, childPath, 'INVALID_CONTENT');
      return;
    }
    validateBlock(context, child, childPath, depth + 1);
  });
}

function validateListItem(
  context: Context,
  item: unknown,
  path: string,
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    report(context, path, 'TOO_DEEP');
    return;
  }
  if (!isRecord(item) || typeof item.type !== 'string') {
    report(context, path, 'INVALID_SHAPE');
    return;
  }
  if (item.type !== 'listItem') {
    report(context, path, 'INVALID_CONTENT');
    return;
  }
  checkKeys(context, item, ['type', 'attrs', 'content'], path);
  checkNoAttrs(context, item, path);
  validateBlockList(context, item.content, path, depth, true);
}

function validateList(
  context: Context,
  node: Record<string, unknown>,
  path: string,
  depth: number,
  ordered: boolean,
): void {
  checkKeys(context, node, ['type', 'attrs', 'content'], path);
  const attrs = readAttrs(context, node, ordered ? ['start'] : [], path);
  if (ordered && attrs !== null && isSet(attrs.start)) {
    const start = attrs.start;
    if (
      typeof start !== 'number' ||
      !Number.isInteger(start) ||
      start < 1 ||
      start > ORDERED_LIST_START_MAX
    ) {
      report(context, join(join(path, 'attrs'), 'start'), 'INVALID_SHAPE');
    }
  }
  const items = node.content;
  const contentPath = join(path, 'content');
  if (items === undefined || (Array.isArray(items) && items.length === 0)) {
    report(context, contentPath, 'INVALID_CONTENT');
    return;
  }
  if (!Array.isArray(items)) {
    report(context, contentPath, 'INVALID_SHAPE');
    return;
  }
  items.forEach((item: unknown, index) => {
    validateListItem(context, item, join(contentPath, index), depth + 1);
  });
}

function validateBlock(
  context: Context,
  node: unknown,
  path: string,
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    report(context, path, 'TOO_DEEP');
    return;
  }
  if (!isRecord(node) || typeof node.type !== 'string') {
    report(context, path, 'INVALID_SHAPE');
    return;
  }
  const type = node.type;
  switch (type) {
    case 'paragraph':
      validateParagraph(context, node, path, depth);
      return;
    case 'heading':
      validateHeading(context, node, path, depth);
      return;
    case 'bulletList':
    case 'orderedList':
    case 'blockquote':
    case 'horizontalRule':
    case 'cta':
      if (!context.theme.nodes.includes(type)) {
        report(context, path, 'NODE_NOT_ALLOWED');
        return;
      }
      if (type === 'bulletList' || type === 'orderedList') {
        validateList(context, node, path, depth, type === 'orderedList');
      } else if (type === 'blockquote') {
        checkKeys(context, node, ['type', 'attrs', 'content'], path);
        checkNoAttrs(context, node, path);
        validateBlockList(context, node.content, path, depth, false);
      } else if (type === 'horizontalRule') {
        checkKeys(context, node, ['type', 'attrs', 'content'], path);
        checkNoAttrs(context, node, path);
        checkLeafContent(context, node, path);
      } else {
        validateCta(context, node, path);
      }
      return;
    default:
      report(
        context,
        path,
        KNOWN_NODE_TYPES.includes(type) ? 'NODE_NOT_ALLOWED' : 'UNKNOWN_NODE',
      );
  }
}

/**
 * Check `doc` against `theme`. Returns every problem found (capped), each as
 * a dot-joined path and a code, and an empty list when the document is
 * acceptable. Never echoes a submitted value, never throws on hostile input,
 * and does not depend on the order of keys or of marks.
 */
export function validateRichTextDocument(
  doc: unknown,
  theme: TextTheme,
): readonly RichTextIssue[] {
  const context: Context = { theme, issues: [] };
  if (!isRecord(doc)) {
    report(context, '', 'INVALID_SHAPE');
    return context.issues;
  }
  checkKeys(context, doc, ['type', 'attrs', 'content'], '');
  if (doc.type !== 'doc') report(context, 'type', 'INVALID_SHAPE');
  checkNoAttrs(context, doc, '');
  const content = doc.content;
  if (content === undefined) return context.issues;
  if (!Array.isArray(content)) {
    report(context, 'content', 'INVALID_SHAPE');
    return context.issues;
  }
  content.forEach((child: unknown, index) => {
    validateBlock(context, child, join('content', index), 2);
  });
  return context.issues;
}

/** True when `doc` has no issues for `theme`. */
export function isRichTextDocumentInTheme(
  doc: unknown,
  theme: TextTheme,
): boolean {
  return validateRichTextDocument(doc, theme).length === 0;
}

/** Every word under `root`: text nodes and CTA labels, in document order, without recursion. */
function plainText(root: unknown): string {
  const parts: string[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index -= 1) {
        stack.push(node[index]);
      }
      continue;
    }
    if (!isRecord(node)) continue;
    if (typeof node.text === 'string') parts.push(node.text);
    if (node.type === 'cta' && isRecord(node.attrs)) {
      if (typeof node.attrs.label === 'string') parts.push(node.attrs.label);
    }
    stack.push(node.content);
  }
  return parts.join('');
}

type LinkParts = {
  readonly href: string | null;
  readonly pageId: string | null;
  readonly target: '_blank' | null;
};

/** The usable target of a link or CTA's attrs, preferring a page over a typed address. */
function pickLinkTarget(attrs: Record<string, unknown>): LinkParts | null {
  const pageId =
    typeof attrs.pageId === 'string' && PAGE_ID_PATTERN.test(attrs.pageId)
      ? attrs.pageId
      : null;
  const href =
    pageId === null &&
    typeof attrs.href === 'string' &&
    isAllowedHref(attrs.href)
      ? attrs.href
      : null;
  if (pageId === null && href === null) return null;
  return { href, pageId, target: attrs.target === '_blank' ? '_blank' : null };
}

function stripPaletteMark(
  type: 'textColor' | 'textSize',
  attrs: Record<string, unknown>,
  tokens: readonly string[],
  isLiteral: (value: string) => boolean,
  allowCustomValues: boolean,
): RichTextMarkJson | null {
  if (typeof attrs.token === 'string' && tokens.includes(attrs.token)) {
    return { type, attrs: { token: attrs.token, value: null } };
  }
  if (
    allowCustomValues &&
    typeof attrs.value === 'string' &&
    isLiteral(attrs.value)
  ) {
    return { type, attrs: { token: null, value: attrs.value } };
  }
  return null;
}

function stripMarks(
  marks: unknown,
  theme: TextTheme,
): readonly RichTextMarkJson[] {
  if (!Array.isArray(marks)) return [];
  const seen = new Set<string>();
  const kept: RichTextMarkJson[] = [];
  for (const mark of marks as unknown[]) {
    if (!isRecord(mark) || typeof mark.type !== 'string') continue;
    const type = mark.type;
    if (seen.has(type)) continue;
    const attrs = isRecord(mark.attrs) ? mark.attrs : {};
    let stripped: RichTextMarkJson | null = null;
    switch (type) {
      case 'bold':
      case 'italic':
      case 'underline':
      case 'strike':
        if (theme.marks.includes(type)) stripped = { type };
        break;
      case 'link': {
        const target = theme.marks.includes('link')
          ? pickLinkTarget(attrs)
          : null;
        if (target !== null) stripped = { type, attrs: { ...target } };
        break;
      }
      // A property that allows no colours (or sizes) allows no such mark at all,
      // custom values included: the validator refuses it, so it is not kept.
      case 'textColor':
        stripped =
          theme.colors.length === 0
            ? null
            : stripPaletteMark(
                type,
                attrs,
                theme.colors.map((entry) => entry.token),
                isCustomColorValue,
                theme.allowCustomValues,
              );
        break;
      case 'textSize':
        stripped =
          theme.sizes.length === 0
            ? null
            : stripPaletteMark(
                type,
                attrs,
                theme.sizes.map((entry) => entry.token),
                isCustomSizeValue,
                theme.allowCustomValues,
              );
        break;
      default:
    }
    if (stripped !== null) {
      seen.add(type);
      kept.push(stripped);
    }
  }
  return kept;
}

function textNode(text: string, marks?: readonly RichTextMarkJson[]) {
  return marks !== undefined && marks.length > 0
    ? { type: 'text', text, marks }
    : { type: 'text', text };
}

/** One textblock of the source, as one block or, at a disallowed hard break, several. */
function stripTextblock(
  node: Record<string, unknown>,
  theme: TextTheme,
  level: number | null,
): RichTextNodeJson[] {
  const sourceAttrs = isRecord(node.attrs) ? node.attrs : {};
  const align =
    theme.align &&
    typeof sourceAttrs.textAlign === 'string' &&
    (TEXT_ALIGNS as readonly string[]).includes(sourceAttrs.textAlign)
      ? sourceAttrs.textAlign
      : null;
  const attrs: Record<string, unknown> | undefined =
    level !== null
      ? theme.align
        ? { level, textAlign: align }
        : { level }
      : theme.align
        ? { textAlign: align }
        : undefined;
  const type = level !== null ? 'heading' : 'paragraph';

  const keepBreaks = theme.nodes.includes('hardBreak');
  const lines: RichTextNodeJson[][] = [[]];
  const content = Array.isArray(node.content)
    ? (node.content as unknown[])
    : [];
  for (const child of content) {
    if (!isRecord(child)) continue;
    const current = lines[lines.length - 1];
    if (current === undefined) continue;
    if (child.type === 'text') {
      if (typeof child.text === 'string' && child.text.length > 0) {
        current.push(textNode(child.text, stripMarks(child.marks, theme)));
      }
    } else if (child.type === 'hardBreak') {
      if (keepBreaks) current.push({ type: 'hardBreak' });
      else lines.push([]);
    } else {
      const text = plainText(child);
      if (text.length > 0) current.push(textNode(text));
    }
  }

  const filled = lines.filter((line) => line.length > 0);
  const blocks = filled.length === 0 ? [[]] : filled;
  return blocks.map((line) => ({
    type,
    ...(attrs === undefined ? {} : { attrs }),
    ...(line.length === 0 ? {} : { content: line }),
  }));
}

function paragraphOf(text: string): RichTextNodeJson[] {
  return text.length === 0
    ? []
    : [{ type: 'paragraph', content: [textNode(text)] }];
}

function stripCta(
  node: Record<string, unknown>,
  theme: TextTheme,
): RichTextNodeJson[] {
  const attrs = isRecord(node.attrs) ? node.attrs : {};
  const label = typeof attrs.label === 'string' ? attrs.label : '';
  if (label.length > CTA_LABEL_MAX_LENGTH) return paragraphOf(label);
  const target = pickLinkTarget(attrs);
  const variant =
    typeof attrs.variant === 'string' &&
    theme.ctaVariants.some((entry) => entry.value === attrs.variant)
      ? attrs.variant
      : (theme.ctaVariants[0]?.value ?? null);
  return [
    {
      type: 'cta',
      attrs: {
        label,
        href: target?.href ?? null,
        pageId: target?.pageId ?? null,
        target: target?.target ?? null,
        variant,
      },
    },
  ];
}

function withParagraphFirst(blocks: RichTextNodeJson[]): RichTextNodeJson[] {
  return blocks[0]?.type === 'paragraph'
    ? blocks
    : [{ type: 'paragraph' }, ...blocks];
}

function stripList(
  node: Record<string, unknown>,
  theme: TextTheme,
  depth: number,
  ordered: boolean,
): RichTextNodeJson[] {
  const children = Array.isArray(node.content)
    ? (node.content as unknown[])
    : [];
  const type = ordered ? 'orderedList' : 'bulletList';
  if (!theme.nodes.includes(type)) {
    return children.flatMap((child) =>
      isRecord(child) && child.type === 'listItem'
        ? stripBlocks(child.content, theme, depth + 1)
        : stripBlock(child, theme, depth + 1),
    );
  }
  const items: RichTextNodeJson[] = [];
  for (const child of children) {
    const blocks =
      isRecord(child) && child.type === 'listItem'
        ? stripBlocks(child.content, theme, depth + 2)
        : stripBlock(child, theme, depth + 2);
    if (blocks.length > 0) {
      items.push({ type: 'listItem', content: withParagraphFirst(blocks) });
    }
  }
  if (items.length === 0) return [];
  const sourceAttrs = isRecord(node.attrs) ? node.attrs : {};
  const start = sourceAttrs.start;
  const validStart =
    typeof start === 'number' &&
    Number.isInteger(start) &&
    start >= 1 &&
    start <= ORDERED_LIST_START_MAX
      ? start
      : null;
  return [
    ordered
      ? { type, attrs: { start: validStart }, content: items }
      : { type, content: items },
  ];
}

function stripLeaf(
  node: Record<string, unknown>,
  type: 'horizontalRule' | 'cta',
  theme: TextTheme,
): RichTextNodeJson[] {
  if (type === 'horizontalRule') {
    return theme.nodes.includes(type) ? [{ type }] : [];
  }
  if (theme.nodes.includes(type)) return stripCta(node, theme);
  const label = isRecord(node.attrs) ? node.attrs.label : undefined;
  return typeof label === 'string' ? paragraphOf(label) : [];
}

function stripBlock(
  node: unknown,
  theme: TextTheme,
  depth: number,
): RichTextNodeJson[] {
  if (!isRecord(node)) return [];
  const type = typeof node.type === 'string' ? node.type : '';
  // A container this deep could not hold a paragraph with text and still
  // pass the depth cap, so its words are kept as one paragraph instead.
  if (depth >= MAX_DEPTH - 3 && !LEAF_BLOCK_TYPES.includes(type)) {
    return paragraphOf(plainText(node));
  }
  switch (type) {
    case 'paragraph':
      return stripTextblock(node, theme, null);
    case 'heading': {
      const level = isRecord(node.attrs) ? node.attrs.level : undefined;
      return stripTextblock(
        node,
        theme,
        typeof level === 'number' &&
          (theme.headingLevels as readonly number[]).includes(level)
          ? level
          : null,
      );
    }
    case 'bulletList':
    case 'orderedList':
      return stripList(node, theme, depth, type === 'orderedList');
    case 'blockquote': {
      const inner = stripBlocks(node.content, theme, depth + 1);
      if (!theme.nodes.includes('blockquote')) return inner;
      return inner.length === 0 ? [] : [{ type, content: inner }];
    }
    case 'horizontalRule':
    case 'cta': {
      // Leaf blocks hold no content; any a writer put there is kept after them.
      return [
        ...stripLeaf(node, type, theme),
        ...stripBlocks(node.content, theme, depth + 1),
      ];
    }
    case 'text':
      return stripTextblock({ content: [node] }, theme, null);
    case 'hardBreak':
      return [];
    default: {
      // listItem and doc out of place, and every unknown name: keep their
      // blocks, or treat them as a textblock when they hold inline content.
      const content = Array.isArray(node.content)
        ? (node.content as unknown[])
        : [];
      const holdsInline = content.some(
        (child) =>
          isRecord(child) &&
          (child.type === 'text' || child.type === 'hardBreak'),
      );
      if (holdsInline) return stripTextblock(node, theme, null);
      if (typeof node.text === 'string') return paragraphOf(node.text);
      return stripBlocks(node.content, theme, depth + 1);
    }
  }
}

function stripBlocks(
  value: unknown,
  theme: TextTheme,
  depth: number,
): RichTextNodeJson[] {
  return Array.isArray(value)
    ? (value as unknown[]).flatMap((child) => stripBlock(child, theme, depth))
    : [];
}

/**
 * Rewrite `doc` so it passes `validateRichTextDocument` for `theme` and
 * keeps every word: a block the theme does not allow becomes a paragraph (or
 * is unwrapped), a heading level outside the theme becomes a paragraph, and
 * marks and attributes outside the theme are dropped. Returns null only when
 * the input is not an object of type `doc`.
 */
export function stripOutOfTheme(
  doc: unknown,
  theme: TextTheme,
): RichTextDocument | null {
  if (!isRecord(doc) || doc.type !== 'doc') return null;
  const blocks = stripBlocks(doc.content, theme, 2);
  return blocks.length === 0
    ? { type: 'doc' }
    : { type: 'doc', content: blocks };
}

/** Blocks that never hold other blocks. */
const LEAF_BLOCK_TYPES: readonly string[] = [
  'paragraph',
  'heading',
  'text',
  'hardBreak',
  'horizontalRule',
  'cta',
];

/** Node types that carry meaning without any text. */
const EMPTY_NODE_TYPES: readonly string[] = [
  'doc',
  'paragraph',
  'heading',
  'hardBreak',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'text',
];

/**
 * True for null, a doc with no content and a doc of nothing but empty text
 * blocks; false when any text, CTA, divider or node of unknown type is
 * present. Anything that is not an object cannot be judged empty.
 */
export function isEmptyRichTextDocument(doc: unknown): boolean {
  if (doc === undefined || doc === null) return true;
  if (!isRecord(doc)) return false;
  const stack: unknown[] = [doc];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node as unknown[]) stack.push(child);
      continue;
    }
    if (!isRecord(node)) continue;
    if (typeof node.text === 'string' && node.text.trim().length > 0) {
      return false;
    }
    if (
      typeof node.type === 'string' &&
      !EMPTY_NODE_TYPES.includes(node.type)
    ) {
      return false;
    }
    stack.push(node.content);
  }
  return true;
}

/** Each distinct page id a link or CTA points at, once, in document order. */
export function collectRichTextPageIds(doc: unknown): readonly string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const note = (candidate: unknown): void => {
    if (
      typeof candidate === 'string' &&
      PAGE_ID_PATTERN.test(candidate) &&
      !seen.has(candidate)
    ) {
      seen.add(candidate);
      found.push(candidate);
    }
  };
  const stack: unknown[] = [doc];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index -= 1) {
        stack.push(node[index]);
      }
      continue;
    }
    if (!isRecord(node)) continue;
    if (node.type === 'cta' && isRecord(node.attrs)) note(node.attrs.pageId);
    if (Array.isArray(node.marks)) {
      for (const mark of node.marks as unknown[]) {
        if (isRecord(mark) && mark.type === 'link' && isRecord(mark.attrs)) {
          note(mark.attrs.pageId);
        }
      }
    }
    stack.push(node.content);
  }
  return found;
}

/**
 * True when a CTA's attributes hold a non-blank label and one usable target.
 * An unfinished CTA is still a valid stored value; the renderer and the
 * editor use this to tell the two apart.
 */
export function isCompleteCta(
  attrs: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
  if (attrs === null || attrs === undefined) return false;
  const label = attrs.label;
  if (typeof label !== 'string' || label.trim().length === 0) return false;
  return isCompleteLinkTarget(attrs);
}
