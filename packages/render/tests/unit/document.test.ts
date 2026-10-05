import { describe, expect, it } from 'vitest';
import {
  escapeHtmlAttribute,
  renderDefaultDocument,
} from '../../src/document.js';
import type { PageHead } from '../../src/head.js';

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
    const html = renderDefaultDocument({ head: HEAD, body: '<p>hi</p>' });
    expect(html.indexOf('<head>')).toBeLessThan(html.indexOf('<title>'));
    expect(html.indexOf('<title>')).toBeLessThan(html.indexOf('</head>'));
    expect(html.indexOf('</head>')).toBeLessThan(html.indexOf('<body>'));
  });

  it('adds no script element: zero client JS by default', () => {
    const html = renderDefaultDocument({ head: HEAD, body: '<main>x</main>' });
    expect(html).not.toContain('<script');
  });

  it('escapes a lang value holding a quote', () => {
    const html = renderDefaultDocument({
      head: { ...HEAD, lang: 'en" onload="alert(1)' },
      body: '',
    });
    expect(html).toContain('<html lang="en&quot; onload=&quot;alert(1)">');
    expect(html).not.toContain('<html lang="en" onload');
  });

  it('escapes a hostile title in the head', () => {
    const html = renderDefaultDocument({
      head: { ...HEAD, title: '</title><script>alert(1)</script>' },
      body: '',
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
