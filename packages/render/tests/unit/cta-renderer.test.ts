import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CtaButton } from '../../src/rich-text/cta.js';
import { defineTextTheme } from '../../src/rich-text/define-text-theme.js';
import {
  createTextEnvironment,
  TextEnvironmentProvider,
  type TextEnvironmentInput,
} from '../../src/rich-text/environment.js';
import { RichText } from '../../src/rich-text/rich-text.js';

const PAGE_ID = '7d3a9e20-1b44-4f0c-8e5a-6c1d2b3a4f55';

const environment: TextEnvironmentInput = {
  resolvePage: (id) => (id === PAGE_ID ? '/read-more' : null),
};

function within(input: TextEnvironmentInput, child: unknown): string {
  return renderToStaticMarkup(
    createElement(
      TextEnvironmentProvider,
      { environment: createTextEnvironment(input) },
      child as never,
    ),
  );
}

function inText(
  attrs: Record<string, unknown>,
  input: TextEnvironmentInput = environment,
): string {
  const value = { type: 'doc', content: [{ type: 'cta', attrs }] };
  return within(input, createElement(RichText, { value }));
}

function standalone(
  label: unknown,
  link: unknown,
  variant: unknown,
  input: TextEnvironmentInput = environment,
): string {
  return within(input, createElement(CtaButton, { label, link, variant }));
}

const row = (inner: string): string => `<div data-cta-row="">${inner}</div>`;

describe('CtaButton', () => {
  it.each([
    ['an address', { href: '/contact', pageId: null, target: null }, 'primary'],
    [
      'a page in a new tab',
      { href: null, pageId: PAGE_ID, target: '_blank' },
      'secondary',
    ],
  ])(
    'renders exactly what an in-text CTA renders for %s',
    (_name, link, variant) => {
      const alone = standalone('Go', link, variant);
      expect(alone).not.toBe('');
      expect(row(alone)).toBe(inText({ label: 'Go', ...link, variant }));
    },
  );

  it('uses the theme first variant for an unknown variant', () => {
    const definition = defineTextTheme({
      ctaVariants: [
        { label: 'Solid', value: 'solid' },
        { label: 'Ghost', value: 'ghost' },
      ],
    });
    const html = standalone(
      'Go',
      { href: '/x', pageId: null, target: null },
      'nope',
      { definition },
    );
    expect(html).toBe('<a href="/x" data-variant="solid">Go</a>');
  });

  it.each([
    ['no label', '', { href: '/x', pageId: null, target: null }],
    ['a blank label', '   ', { href: '/x', pageId: null, target: null }],
    ['no target', 'Go', { href: null, pageId: null, target: null }],
    ['a refused address', 'Go', { href: 'javascript:alert(1)' }],
    [
      'an unresolvable page',
      'Go',
      { pageId: '0b5f4c1e-3c52-4a53-9a61-2f2b9d0f7c11' },
    ],
    ['garbage', 'Go', 'not a target'],
  ])('renders nothing for a visitor with %s', (_name, label, link) => {
    expect(standalone(label, link, 'primary')).toBe('');
  });

  it('renders an unfinished button without an href for an editor', () => {
    expect(
      standalone('Go', { href: null, pageId: null, target: null }, 'primary', {
        mode: 'edit',
      }),
    ).toBe('<span data-variant="primary">Go</span>');
  });
});
