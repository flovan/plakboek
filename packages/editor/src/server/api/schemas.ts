/**
 * The shapes the editor API accepts. A body or a route parameter is parsed
 * here before anything reads it; a failure names the offending keys and zod's
 * issue codes, never a value.
 */
import { BLOCK_EDIT_MAX_NODES, BLOCK_EDIT_MAX_OPS } from '@plakboek/pages';
import { z } from 'zod';
import type { ApiIssue } from '../../api-types.js';
import { ApiHttpError } from './http.js';

/** The longest address the API reads, matching the visitor path bound. */
const MAX_PATH_LENGTH = 2048;

/** `/cms/api/open`: the visitor path of the page to edit. Only a site-relative
 * path is accepted: it starts with one slash and carries no backslash. */
export const openBody = z.object({
  path: z
    .string()
    .min(1)
    .max(MAX_PATH_LENGTH)
    .refine(
      (path) =>
        path.startsWith('/') && !path.startsWith('//') && !path.includes('\\'),
      { message: 'path' },
    ),
});

/** The lock endpoints take no input but are still JSON. */
export const emptyBody = z.object({});

/** A page id in a route. */
export const pageIdParam = z.uuid();

/** A block or page id: a lowercase uuid, the only form the engine stores. */
const id = z.uuid().refine((value) => value === value.toLowerCase(), {
  message: 'uuid',
});

/** A column ratio is checked against the presets by the engine; here it is
 * only bounded. */
const MAX_COLUMNS_LENGTH = 512;

/** How deep a node an insert op may nest. The configured block depth ceiling
 * is far lower; this only keeps the schema's own recursion bounded. */
const MAX_NODE_DEPTH = 32;

/** Layout values a block may carry; any other key is refused. */
const layout = z.strictObject({
  columns: z.string().max(MAX_COLUMNS_LENGTH).optional(),
  align: z.enum(['stretch', 'start', 'center', 'end']).optional(),
  fill: z.boolean().optional(),
});

/** A property map: a plain object. Its values are checked by the engine
 * against the block's declared properties. */
const props = z.record(z.string(), z.unknown());

/** An insert op's node, as parsed. Optional keys carry `undefined` because
 * the parsed shape is not the wire contract. */
export type EditNodeInput = {
  id?: string | undefined;
  type: string;
  props?: Record<string, unknown> | undefined;
  layout?:
    | {
        columns?: string | undefined;
        align?: 'stretch' | 'start' | 'center' | 'end' | undefined;
        fill?: boolean | undefined;
      }
    | null
    | undefined;
  children?: EditNodeInput[] | undefined;
};

/** A node schema that nests at most `levels` more times. */
function nodeSchema(levels: number): z.ZodType<EditNodeInput> {
  return z.strictObject({
    id: id.optional(),
    type: z.string().min(1).max(64),
    props: props.optional(),
    layout: layout.nullable().optional(),
    children: (levels > 0
      ? z.array(nodeSchema(levels - 1))
      : z.array(z.never())
    )
      .max(BLOCK_EDIT_MAX_NODES)
      .optional(),
  });
}

function countNodes(node: EditNodeInput): number {
  let count = 0;
  const pending: EditNodeInput[] = [node];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    count += 1;
    pending.push(...(next.children ?? []));
  }
  return count;
}

const node = nodeSchema(MAX_NODE_DEPTH);

const position = z.strictObject({
  parentId: id.nullable(),
  previousId: id.nullable().optional(),
  nextId: id.nullable().optional(),
});

const baseVersion = z.number().int().min(1);

const op = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('insert'), position, node }),
  z.strictObject({
    op: z.literal('update'),
    blockId: id,
    baseVersion,
    props: props.optional(),
    layout: layout.nullable().optional(),
  }),
  z.strictObject({
    op: z.literal('move'),
    blockId: id,
    baseVersion,
    position,
  }),
  z.strictObject({ op: z.literal('delete'), blockId: id, baseVersion }),
  z.strictObject({
    op: z.literal('duplicate'),
    blockId: id,
    newId: id.optional(),
  }),
]);

/** `POST .../edit`: one batch of ops against a page version. The total of
 * inserted nodes is bounded like the engine bounds it, so a batch the engine
 * would refuse as too large never reaches it. */
export const editBody = z
  .strictObject({
    basePageVersion: baseVersion,
    ops: z.array(op).min(1).max(BLOCK_EDIT_MAX_OPS),
    fragments: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.ops.reduce(
        (total, next) =>
          total + (next.op === 'insert' ? countNodes(next.node) : 0),
        0,
      ) <= BLOCK_EDIT_MAX_NODES,
    { message: 'nodes' },
  );

export type EditBody = z.output<typeof editBody>;
export type EditBodyOp = EditBody['ops'][number];

/** `POST .../preview`: candidate values for one block of the page. */
export const previewBody = z.strictObject({
  blockId: id,
  props: props.optional(),
  layout: layout.nullable().optional(),
});

export type PreviewBody = z.output<typeof previewBody>;

function issuesOf(error: z.ZodError): readonly ApiIssue[] {
  return error.issues.map((issue) => ({
    key: issue.path.length === 0 ? 'body' : issue.path.map(String).join('.'),
    code: issue.code,
  }));
}

/** The parsed value, or an `ApiHttpError` 400 naming keys and codes. */
export function parseWith<T extends z.ZodType>(
  schema: T,
  input: unknown,
): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiHttpError(400, 'invalid-request', issuesOf(result.error));
  }
  return result.data;
}
