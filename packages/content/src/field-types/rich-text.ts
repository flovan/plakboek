/**
 * The `rich_text` field type (T-03-15): stored as editor JSON, never HTML.
 * A value must be a `doc` node holding nested `{ type, attrs?, content?,
 * marks?, text? }` nodes, `type` matching a plain identifier -- an HTML
 * string never parses as this shape. Shape and size come first, capped at
 * `RICH_TEXT_MAX_BYTES` UTF-8 bytes and `RICH_TEXT_MAX_DEPTH` nesting
 * levels (T-03-13); only then is the document held to the effective text
 * theme (the registered global theme narrowed by the property's `narrow`
 * option), so a node, mark, colour, size or href outside it is refused as
 * invalid, naming the path and a code and never the value (TEXT-03,
 * TEXT-04).
 *
 * `buildStoredValueSchema` is the shape-only schema an unchanged stored
 * value is held to on a working-tree write: a theme that was narrowed after
 * the text was written never blocks an edit to another property (keep data,
 * flag, never crash). Publishing uses `buildValueSchema` and stays strict.
 *
 * Exports a plain `FieldTypeDefinition` object; only imports the *type* of
 * `FieldTypeDefinition` back from `registry.ts` (erased at compile time) --
 * no circular import.
 */
import { z } from 'zod';
import type { FieldTypeDefinition } from './registry.js';
import {
  isEmptyRichTextDocument,
  validateRichTextDocument,
} from '../rich-text/index.js';
import {
  effectiveTextTheme,
  richTextOptionsSchema,
  type RichTextOptions,
} from './text-theme-registry.js';
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

/**
 * The structural guard runs first and short-circuits, because both the
 * recursive schema below and nodeDepth walk the value with real stack
 * frames. Without it a deeply nested document escapes safeParse as an
 * uncaught RangeError instead of a validation issue. Size and depth caps
 * run before `themeCheck`, so an oversized document is refused as such
 * before any theme rule looks at it.
 */
function buildSchema(
  themeCheck: ((value: unknown) => readonly string[]) | undefined,
): z.ZodType {
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
      if (byteLength > RICH_TEXT_MAX_BYTES || depth > RICH_TEXT_MAX_DEPTH) {
        return;
      }
      for (const message of themeCheck?.(value) ?? []) {
        ctx.addIssue({ code: 'custom', message });
      }
    }),
  );
}

function buildRichTextValueSchema(options: RichTextOptions): z.ZodType {
  return buildSchema((value) =>
    validateRichTextDocument(value, effectiveTextTheme(options)).map((issue) =>
      issue.path === '' ? issue.code : `${issue.code} at ${issue.path}`,
    ),
  );
}

function buildRichTextStoredValueSchema(_options: RichTextOptions): z.ZodType {
  return buildSchema(undefined);
}

export const richTextFieldType = {
  fieldType: 'rich_text',
  optionsSchema: richTextOptionsSchema,
  buildValueSchema: buildRichTextValueSchema,
  buildStoredValueSchema: buildRichTextStoredValueSchema,
  isEmptyValue: isEmptyRichTextDocument,
  widgets: ['rich-text-editor'] as const,
  defaultWidget: 'rich-text-editor',
  allowedInRepeater: true,
} satisfies FieldTypeDefinition<RichTextOptions>;
