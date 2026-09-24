/**
 * The `rich_text` field type (T-03-15): stored as editor JSON, never HTML.
 * A value must be a `doc` node holding nested `{ type, attrs?, content?,
 * marks?, text? }` nodes, `type` matching a plain identifier -- an HTML
 * string never parses as this shape. Allowed node/mark *sets* belong to
 * Phase 9's theme lock; this module validates shape only, capped at
 * `RICH_TEXT_MAX_BYTES` UTF-8 bytes and `RICH_TEXT_MAX_DEPTH` nesting
 * levels (T-03-13).
 *
 * Exports a plain `FieldTypeDefinition` object; only imports the *type* of
 * `FieldTypeDefinition` back from `registry.ts` (erased at compile time) --
 * no circular import.
 */
import { z } from 'zod';
import type { FieldTypeDefinition } from './registry.js';
import { exceedsNestingDepth, MAX_VALUE_NESTING_DEPTH } from './value-depth.js';

export const RICH_TEXT_MAX_BYTES = 1_000_000;
export const RICH_TEXT_MAX_DEPTH = 32;

const NODE_TYPE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;

type RichTextNode = {
  readonly type: string;
  readonly attrs?: Record<string, unknown>;
  readonly content?: readonly RichTextNode[];
  readonly marks?: readonly unknown[];
  readonly text?: string;
};

const richTextNodeSchema: z.ZodType<RichTextNode> = z.lazy(() =>
  z.strictObject({
    type: z.string().regex(NODE_TYPE_PATTERN, 'must be a valid node type name'),
    attrs: z.record(z.string(), z.unknown()).optional(),
    content: z.array(richTextNodeSchema).optional(),
    marks: z.array(z.unknown()).optional(),
    text: z.string().optional(),
  }),
);

const richTextDocSchema = z.strictObject({
  type: z.literal('doc'),
  attrs: z.record(z.string(), z.unknown()).optional(),
  content: z.array(richTextNodeSchema).optional(),
});

const richTextOptionsSchema = z.strictObject({});

type RichTextOptions = z.infer<typeof richTextOptionsSchema>;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function nodeDepth(node: RichTextNode, currentDepth: number): number {
  if (node.content === undefined || node.content.length === 0) {
    return currentDepth;
  }
  let maxDepth = currentDepth;
  for (const child of node.content) {
    const childDepth = nodeDepth(child, currentDepth + 1);
    if (childDepth > maxDepth) maxDepth = childDepth;
  }
  return maxDepth;
}

const structuralDepthGuard = z.unknown().superRefine((value, ctx) => {
  if (exceedsNestingDepth(value)) {
    ctx.addIssue({
      code: 'custom',
      message: `must not nest deeper than ${MAX_VALUE_NESTING_DEPTH} levels`,
    });
  }
});

function buildRichTextValueSchema(_options: RichTextOptions): z.ZodType {
  // The structural guard runs first and short-circuits, because both the
  // recursive schema below and nodeDepth walk the value with real stack
  // frames. Without it a deeply nested document escapes safeParse as an
  // uncaught RangeError instead of a validation issue.
  return structuralDepthGuard.pipe(
    richTextDocSchema.superRefine((value, ctx) => {
      const byteLength = utf8ByteLength(JSON.stringify(value));
      if (byteLength > RICH_TEXT_MAX_BYTES) {
        ctx.addIssue({
          code: 'custom',
          message: `must be at most ${RICH_TEXT_MAX_BYTES} UTF-8 bytes`,
        });
      }
      const depth = nodeDepth(value, 1);
      if (depth > RICH_TEXT_MAX_DEPTH) {
        ctx.addIssue({
          code: 'custom',
          message: `must be nested at most ${RICH_TEXT_MAX_DEPTH} levels deep`,
        });
      }
    }),
  );
}

function isEmptyRichTextValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const content = Reflect.get(value, 'content');
  return (
    content === undefined || (Array.isArray(content) && content.length === 0)
  );
}

export const richTextFieldType = {
  fieldType: 'rich_text',
  optionsSchema: richTextOptionsSchema,
  buildValueSchema: buildRichTextValueSchema,
  isEmptyValue: isEmptyRichTextValue,
  widgets: ['rich-text-editor'] as const,
  defaultWidget: 'rich-text-editor',
  allowedInRepeater: true,
} satisfies FieldTypeDefinition<RichTextOptions>;
