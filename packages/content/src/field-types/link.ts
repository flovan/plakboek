/**
 * The CMS `link` field type: one link target, held as `{ href, pageId,
 * target }` with exactly one of an address and a page of the installation
 * (resolved at render time, so a renamed page keeps its links), plus an
 * optional `_blank` target. The address passes through the same href policy
 * the rich text link mark uses (D-17, D-18).
 *
 * It is a host-style definition, not one of the sixteen built-ins: the
 * `content_type_fields` CHECK constraint stays as it is, and core registers
 * it through `registerHostFieldType` for block properties.
 */
import { z } from 'zod';
import { linkTargetSchema } from '../rich-text/index.js';
import type { HostFieldTypeDefinition } from './registry.js';

export const LINK_FIELD_TYPE_KEY = 'link';

/** The shape of a block property key, so the sibling names below can be
 * checked against the block's own properties by whoever declares them. */
const PROPERTY_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;

const linkOptionsSchema = z.strictObject({
  /** The sibling short text property edited together with the link. */
  labelProperty: z.string().regex(PROPERTY_KEY_PATTERN).optional(),
  /** The sibling select property carrying a button's variant. */
  variantProperty: z.string().regex(PROPERTY_KEY_PATTERN).optional(),
});

type LinkOptions = z.infer<typeof linkOptionsSchema>;

function isEmptyLinkValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  return (
    (Reflect.get(value, 'href') ?? null) === null &&
    (Reflect.get(value, 'pageId') ?? null) === null
  );
}

export const LINK_FIELD_TYPE = {
  fieldType: LINK_FIELD_TYPE_KEY,
  optionsSchema: linkOptionsSchema,
  buildValueSchema: (_options: LinkOptions) => linkTargetSchema,
  isEmptyValue: isEmptyLinkValue,
  widgets: ['link-picker'] as const,
  defaultWidget: 'link-picker',
  allowedInRepeater: true,
} satisfies HostFieldTypeDefinition<LinkOptions>;
