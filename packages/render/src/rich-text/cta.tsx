/**
 * The call to action, in one place. A CTA inside text and the standalone
 * Button block both render through `renderers.cta` with the same variant list
 * and the same completeness rule, so the two look identical (D-17).
 *
 * An incomplete CTA (no label, no usable target) is kept as stored data but
 * not shown to visitors; in edit mode it renders without an href so the
 * editor can anchor its "needs a link" marker on it.
 */
import {
  createElement,
  type Key,
  type ReactElement,
  type ReactNode,
} from 'react';
import { linkTargetSchema } from '@plakboek/content/rich-text';
import { useTextEnvironment, type TextEnvironment } from './environment.js';
import { resolveTarget } from './target.js';

export type CtaInput = {
  readonly label: unknown;
  /** A `{ href, pageId, target }` value; anything else is incomplete. */
  readonly link: unknown;
  readonly variant: unknown;
};

/** A variant the theme lists, else the theme's first one. */
function variantOf(environment: TextEnvironment, variant: unknown): string {
  const variants = environment.theme.ctaVariants;
  if (
    typeof variant === 'string' &&
    variants.some((entry) => entry.value === variant)
  ) {
    return variant;
  }
  return variants[0]?.value ?? '';
}

/** The CTA element, or `null` when a visitor must not see it. */
export function renderCta(
  environment: TextEnvironment,
  input: CtaInput,
  key?: Key | null,
): ReactElement | null {
  const variant = variantOf(environment, input.variant);
  const label = typeof input.label === 'string' ? input.label : '';
  const parsed = linkTargetSchema.safeParse(input.link);
  const resolved = parsed.success
    ? resolveTarget(environment, parsed.data)
    : null;
  if (label.trim().length === 0 || resolved === null) {
    if (environment.mode !== 'edit') return null;
    return createElement(environment.renderers.cta, {
      key: key ?? null,
      label,
      href: null,
      target: null,
      variant,
    });
  }
  return createElement(environment.renderers.cta, {
    key: key ?? null,
    label,
    href: resolved.href,
    target: resolved.target,
    variant,
  });
}

export type CtaButtonProps = CtaInput;

/**
 * A standalone call-to-action button: what the core Button block renders.
 * Reads the same environment as `RichText`, so it takes the host's `cta`
 * renderer and variant list.
 */
export function CtaButton({ label, link, variant }: CtaButtonProps): ReactNode {
  const environment = useTextEnvironment();
  return renderCta(environment, { label, link, variant });
}
