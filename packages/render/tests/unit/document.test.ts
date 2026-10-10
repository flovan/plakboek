import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  escapeHtmlAttribute,
  renderDefaultDocument,
} from '../../src/document.js';
import type { DocumentInput, DocumentMode, PageHead } from '../../src/head.js';

const HEAD: PageHead = {
  lang: 'en',
  title: 'About us',
  description: 'The team',
  canonicalUrl: null,
  robots: null,
  imageUrl: null,
};

describe('renderDefaultDocument', () => {
  it('returns a complete document with the head markup and the body verbatim', () => {
    const html = renderDefaultDocument({
      head: HEAD,
      body: '<main>x</main>',
      publicPath: '/about-us',
      mode: 'visitor',
    });
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
    expect(html).toContain('<title>About us</title>');
    expect(html).toContain('<meta name="description" content="The team"/>');
    expect(html).toContain('<body><main>x</main></body>');
    expect(html.endsWith('</html>')).toBe(true);
  });

  it('places the head markup inside <head> and the body inside <body>', () => {
    const html = renderDefaultDocument({
      head: HEAD,
      body: '<p>hi</p>',
      publicPath: '/about-us',
      mode: 'visitor',
    });
    expect(html.indexOf('<head>')).toBeLessThan(html.indexOf('<title>'));
    expect(html.indexOf('<title>')).toBeLessThan(html.indexOf('</head>'));
    expect(html.indexOf('</head>')).toBeLessThan(html.indexOf('<body>'));
  });

  it('adds no script element: zero client JS by default', () => {
    const html = renderDefaultDocument({
      head: HEAD,
      body: '<main>x</main>',
      publicPath: '/about-us',
      mode: 'visitor',
    });
    expect(html).not.toContain('<script');
  });

  it('escapes a lang value holding a quote', () => {
    const html = renderDefaultDocument({
      head: { ...HEAD, lang: 'en" onload="alert(1)' },
      body: '',
      publicPath: '/about-us',
      mode: 'visitor',
    });
    expect(html).toContain('<html lang="en&quot; onload=&quot;alert(1)">');
    expect(html).not.toContain('<html lang="en" onload');
  });

  it('escapes a hostile title in the head', () => {
    const html = renderDefaultDocument({
      head: { ...HEAD, title: '</title><script>alert(1)</script>' },
      body: '',
      publicPath: '/about-us',
      mode: 'visitor',
    });
    expect(html).not.toContain('<script');
  });
});

describe('escapeHtmlAttribute', () => {
  it('escapes every markup-significant character', () => {
    expect(escapeHtmlAttribute(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeHtmlAttribute('nl-BE')).toBe('nl-BE');
  });
});

describe('the render mode a composer is told (D-21)', () => {
  it('is a required field of DocumentInput', () => {
    // @ts-expect-error a DocumentInput without `mode` does not compile
    const missing: DocumentInput = {
      head: HEAD,
      body: '',
      publicPath: '/about-us',
    };
    expect(missing.body).toBe('');
    expectTypeOf<DocumentInput['mode']>().toEqualTypeOf<DocumentMode>();
    expectTypeOf<DocumentMode>().toEqualTypeOf<'visitor' | 'edit'>();
  });

  it('leaves the default document identical for both modes', () => {
    const base = { head: HEAD, body: '<main>x</main>', publicPath: '/about' };
    expect(renderDefaultDocument({ ...base, mode: 'edit' })).toBe(
      renderDefaultDocument({ ...base, mode: 'visitor' }),
    );
  });
});
