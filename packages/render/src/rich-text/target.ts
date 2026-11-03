/**
 * Turns the stored target of a link or CTA into something safe to render.
 * Every address passes `isAllowedHref` here, at render time, whatever was
 * stored: a document written before a policy change, or through the API,
 * can never put a script address on an anchor.
 */
import { isAllowedHref, PAGE_ID_PATTERN } from '@plakboek/content/rich-text';
import type { TextEnvironment } from './environment.js';

export type ResolvedTarget = {
  readonly href: string;
  readonly target: '_blank' | null;
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pagePath(environment: TextEnvironment, pageId: string): string | null {
  try {
    const path = environment.resolvePage(pageId);
    return typeof path === 'string' && isAllowedHref(path) ? path : null;
  } catch {
    // A host resolver that throws leaves the target unresolved.
    return null;
  }
}

/**
 * The address a `{ href, pageId, target }` value renders as, or `null` when
 * it must render unlinked: nothing set, an href the policy refuses, or a page
 * id that does not resolve. A page id wins when both are present, matching
 * what the validator's repair keeps.
 */
export function resolveTarget(
  environment: TextEnvironment,
  attrs: unknown,
): ResolvedTarget | null {
  if (!isRecord(attrs)) return null;
  const target = attrs.target === '_blank' ? '_blank' : null;
  const { href, pageId } = attrs;
  if (typeof pageId === 'string' && PAGE_ID_PATTERN.test(pageId)) {
    const path = pagePath(environment, pageId);
    return path === null ? null : { href: path, target };
  }
  if (typeof href === 'string' && isAllowedHref(href)) {
    return { href, target };
  }
  return null;
}
