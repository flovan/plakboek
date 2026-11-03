/**
 * The target of a link or CTA: either a typed address or a page of the
 * installation (resolved at render time, so a renamed page keeps its links),
 * never both.
 */
import { z } from 'zod';
import { HREF_MAX_LENGTH, isAllowedHref } from './href.js';

export type LinkTarget = {
  readonly href: string | null;
  readonly pageId: string | null;
  readonly target: '_blank' | null;
};

/** A lowercase uuid, the form every page id is stored in. */
export const PAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const linkTargetSchema = z
  .strictObject({
    href: z
      .string()
      .max(HREF_MAX_LENGTH)
      .refine(isAllowedHref, { message: 'must be an allowed href' })
      .nullable()
      .default(null),
    pageId: z.string().regex(PAGE_ID_PATTERN).nullable().default(null),
    target: z.literal('_blank').nullable().default(null),
  })
  .refine((value) => (value.href === null) !== (value.pageId === null), {
    message: 'exactly one of href and pageId must be set',
  });

/** True when exactly one of `href` and `pageId` is set and usable. */
export function isCompleteLinkTarget(value: {
  readonly href?: unknown;
  readonly pageId?: unknown;
}): boolean {
  const hrefSet = value.href !== undefined && value.href !== null;
  const pageIdSet = value.pageId !== undefined && value.pageId !== null;
  if (hrefSet === pageIdSet) return false;
  if (hrefSet)
    return typeof value.href === 'string' && isAllowedHref(value.href);
  return typeof value.pageId === 'string' && PAGE_ID_PATTERN.test(value.pageId);
}
