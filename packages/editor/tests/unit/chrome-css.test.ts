import { describe, expect, it } from 'vitest';
import { postProcessChromeCss } from '../../scripts/build-chrome-css.js';
import {
  CHROME_CSS,
  CHROME_CSS_SHA256,
} from '../../src/generated/chrome-css.js';

/**
 * The chrome stylesheet is adopted by shadow roots only. These tests hold the
 * built sheet to the contract chrome depends on (px only, no @property, tokens
 * for both colour schemes, a host attribute that wins over the browser's
 * preference) and prove the build's guards can fail with seeded input.
 */

/** The compiled sheet with whitespace after colons and commas removed, so
 * assertions do not depend on the minifier's spacing. */
const css = CHROME_CSS.replace(/:\s+/g, ':').replace(/,\s+/g, ',');

describe('the built chrome stylesheet', () => {
  it('sizes nothing in rem or em', () => {
    expect(CHROME_CSS).not.toMatch(/\d(?:rem|em)\b/);
  });

  it('contains no @property rule', () => {
    expect(CHROME_CSS).not.toContain('@property');
  });

  it('is not a document-level sheet: no preflight reset and no html or body rule', () => {
    expect(css).not.toMatch(/(^|[},])\s*(html|body)\s*[{,]/);
    expect(css).not.toMatch(/(^|[},])\*,:before,:after,::backdrop\{box-sizing/);
  });

  it('defines light accent on the host and dark accent for both dark selectors', () => {
    expect(css).toContain('--pk-accent:#4f46e5');
    expect(css).toContain('--pk-accent:#818cf8');
  });

  it('follows prefers-color-scheme with a dark block on the host', () => {
    expect(css).toMatch(/@media \(prefers-color-scheme:dark\)\{:host\{/);
  });

  it('lets a data-theme attribute on the host override the preference', () => {
    expect(css).toMatch(/:host\(\[data-theme=["']?dark["']?\]\)\{/);
    expect(css).toMatch(/:host\(\[data-theme=["']?light["']?\]\)\{/);
  });

  it('declares every colour token for the light scheme', () => {
    const missing = [
      '--pk-stage:#f4f4f5',
      '--pk-surface:#fff',
      '--pk-surface-muted:#f4f4f5',
      '--pk-accent-contrast:#fff',
      '--pk-accent-hover:#4338ca',
      '--pk-destructive:#b91c1c',
      '--pk-text:#27272a',
      '--pk-text-muted:#52525b',
      '--pk-control-border:#71717a',
      '--pk-border:#e4e4e7',
      '--pk-overlay-outline:#4f46e5',
    ].filter((token) => !css.includes(token));
    expect(missing).toEqual([]);
  });

  it('declares the dark values for the tokens that differ', () => {
    const missing = [
      '--pk-stage:#18181b',
      '--pk-surface:#27272a',
      '--pk-surface-muted:#3f3f46',
      '--pk-accent-contrast:#09090b',
      '--pk-accent-hover:#a5b4fc',
      '--pk-destructive:#f87171',
      '--pk-text:#fafafa',
      '--pk-text-muted:#a1a1aa',
      '--pk-border:#3f3f46',
    ].filter((token) => !css.includes(token));
    expect(missing).toEqual([]);
  });

  it('defines the five editing tokens for light, dark, both data-theme values and forced colours', () => {
    const block = (pattern: RegExp): string => {
      const match = css.match(pattern);
      expect(match, `no block for ${String(pattern)}`).not.toBeNull();
      return match![1]!;
    };
    const light = block(/:host\{[^}]*?all:initial([^}]*)\}/);
    const dark = block(
      /@media \(prefers-color-scheme:dark\)\{:host\{([^}]*)\}/,
    );
    const themeLight = block(
      /:host\(\[data-theme=["']?light["']?\]\)\{([^}]*)\}/,
    );
    const themeDark = block(
      /:host\(\[data-theme=["']?dark["']?\]\)\{([^}]*)\}/,
    );
    const forced = block(/@media \(forced-colors:active\)\{:host\{([^}]*)\}/);

    // The minifier may rewrite an rgba() value as 8-digit hex; accept either.
    expect(light).toMatch(
      /--pk-overlay-selected-fill:(rgba\(79,70,229,\.08\)|#4f46e514)/,
    );
    expect(light).toMatch(
      /--pk-overlay-drag-source:(rgba\(24,24,27,\.16\)|#18181b29)/,
    );
    expect(light).toContain('--pk-attention:#b45309');
    expect(light).toContain('--pk-attention-marker:#b45309');
    expect(light).toContain('--pk-destructive-contrast:#fff');

    for (const scheme of [dark, themeDark]) {
      expect(scheme).toContain('--pk-attention:#fbbf24');
      expect(scheme).toContain('--pk-destructive-contrast:#09090b');
      // The overlay tokens are drawn over the site, so they do not change.
      expect(scheme).not.toContain('--pk-overlay-selected-fill');
      expect(scheme).not.toContain('--pk-overlay-drag-source');
      expect(scheme).not.toContain('--pk-attention-marker');
    }

    expect(themeLight).toContain('--pk-attention:#b45309');
    expect(themeLight).toContain('--pk-destructive-contrast:#fff');

    expect(forced).toContain('--pk-overlay-selected-fill:transparent');
    expect(forced).toContain('--pk-attention-marker:Highlight');
  });

  it('maps the five editing tokens into the Tailwind colour theme', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('../../src/styles/chrome.css', import.meta.url),
      'utf8',
    );
    for (const name of [
      'overlay-selected-fill',
      'overlay-drag-source',
      'attention',
      'attention-marker',
      'destructive-contrast',
    ]) {
      expect(source).toContain(`--color-${name}: var(--pk-${name});`);
    }
  });

  it('declares colour-scheme on the host only, so native controls match', () => {
    expect(css).toContain('color-scheme:light dark');
  });

  it('keeps the system font stack and a px base size on the host', () => {
    expect(css).toMatch(/:host\{[^}]*all:initial/);
    expect(css).toMatch(/font:400 14px\/1\.5 -apple-system/);
  });

  it('has a forced-colors block that uses system colours for the overlay', () => {
    expect(css).toMatch(/@media \(forced-colors:active\)\{/);
    expect(css).toContain('Highlight');
    expect(css).toContain('HighlightText');
    expect(css).toContain('CanvasText');
  });

  it('computes translate, shadow and ring variables without an @supports guard', () => {
    // The safelisted utilities need Tailwind's property defaults; they must
    // sit in an @layer properties block that is not wrapped in @supports.
    expect(css).toMatch(/@layer properties\{\*,:before,:after,::backdrop\{/);
    expect(css).not.toContain('@supports');
  });

  it('exposes a hash that matches the stylesheet text', async () => {
    const { createHash } = await import('node:crypto');
    expect(CHROME_CSS_SHA256).toBe(
      createHash('sha256').update(CHROME_CSS).digest('base64'),
    );
  });
});

describe('postProcessChromeCss (seeded input proves each guard can fail)', () => {
  const GUARDED =
    '@layer properties{@supports ((-webkit-hyphens:none)){*,:before,:after,::backdrop{--tw-shadow:0 0 #0000}}}';
  const PROPERTY =
    '@property --tw-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}';

  it('unwraps the @supports guard and removes the @property rules', () => {
    const out = postProcessChromeCss(`${GUARDED}${PROPERTY}.a{color:red}`);
    expect(out).toBe(
      '@layer properties{*,:before,:after,::backdrop{--tw-shadow:0 0 #0000}}.a{color:red}',
    );
  });

  it('fails when @property rules exist but the guard block is missing', () => {
    expect(() => postProcessChromeCss(`${PROPERTY}.a{color:red}`)).toThrow(
      /guard block was not found/,
    );
    expect(() =>
      postProcessChromeCss(
        `@layer properties{*{--tw-x:0}}${PROPERTY}.a{color:red}`,
      ),
    ).toThrow(/guard block was not found/);
  });

  it('accepts a sheet with neither @property rules nor a guard', () => {
    expect(postProcessChromeCss('.a{color:red}')).toBe('.a{color:red}');
  });

  it('fails on a rem unit', () => {
    expect(() => postProcessChromeCss('.a{padding:1.5rem}')).toThrow(
      /relative unit "1\.5rem"/,
    );
  });

  it('fails on an em unit', () => {
    expect(() => postProcessChromeCss('.a{letter-spacing:-.025em}')).toThrow(
      /relative unit/,
    );
  });

  it('does not flag px values or identifiers that merely end in em', () => {
    expect(postProcessChromeCss('.item{margin:4px;padding:8px}')).toContain(
      '4px',
    );
  });

  it('fails on a stylesheet that would end its own style element', () => {
    expect(() => postProcessChromeCss('.a{content:"</style>"}')).toThrow(
      /<\/style/,
    );
  });
});
