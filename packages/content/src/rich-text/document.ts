/**
 * The allowed-set validator for stored rich-text documents. One pure module
 * decides what a document may contain for a given theme, so the server, the
 * editor's schema and the renderer share a single set of acceptance rules.
 * Issues carry a path and a code, never the submitted value.
 */
import type { TextTheme } from './theme.js';

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

type Context = {
  readonly theme: TextTheme;
  readonly issues: RichTextIssue[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/** The attrs of a node or mark that declares none: absent or an empty object. */
function checkNoAttrs(
  context: Context,
  value: Record<string, unknown>,
  path: string,
): void {
  const attrs = value.attrs;
  if (attrs === undefined) return;
  if (!isRecord(attrs) || Object.keys(attrs).length > 0) {
    report(context, join(path, 'attrs'), 'INVALID_SHAPE');
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
    switch (type) {
      case 'bold':
      case 'italic':
      case 'underline':
      case 'strike':
        if (!context.theme.marks.includes(type)) {
          report(context, markPath, 'MARK_NOT_ALLOWED');
          return;
        }
        checkNoAttrs(context, mark, markPath);
        return;
      default:
        report(context, markPath, 'UNKNOWN_MARK');
    }
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
      return;
    }
    report(context, childPath, 'UNKNOWN_NODE');
  });
}

function validateParagraph(
  context: Context,
  node: Record<string, unknown>,
  path: string,
  depth: number,
): void {
  checkKeys(context, node, ['type', 'attrs', 'content'], path);
  checkNoAttrs(context, node, path);
  validateInline(context, node.content, path, depth);
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
  switch (node.type) {
    case 'paragraph':
      validateParagraph(context, node, path, depth);
      return;
    default:
      report(context, path, 'UNKNOWN_NODE');
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
