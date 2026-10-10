import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildCmsDocument,
  buildShellCsp,
  cmsDocumentHeaders,
  cspHashOf,
  escapeHtml,
  escapeJsonForHtml,
  frameHeaders,
} from '../../src/server/html-document.js';

describe('escapeJsonForHtml', () => {
  it('cannot close the script element, whatever a value holds', () => {
    const value = { name: '</script><script>alert(1)</script>' };
    const text = escapeJsonForHtml(value);
    expect(text).not.toContain('<');
    expect(text).not.toContain('>');
    expect(JSON.parse(text)).toEqual(value);
  });

  it('escapes the ampersand and the comment openers', () => {
    const value = { name: 'a & b <!-- c --> d' };
    const text = escapeJsonForHtml(value);
    expect(text).not.toContain('&');
    expect(text).not.toContain('<!--');
    expect(JSON.parse(text)).toEqual(value);
  });

  it('escapes U+2028 and U+2029, which a script parser reads as line ends', () => {
    const value = { name: 'a b c' };
    const text = escapeJsonForHtml(value);
    expect(text).not.toContain(' ');
    expect(text).not.toContain(' ');
    expect(text).toContain('\\u2028');
    expect(text).toContain('\\u2029');
    expect(JSON.parse(text)).toEqual(value);
  });
});

describe('escapeHtml', () => {
  it('escapes the five markup characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});

describe('cspHashOf', () => {
  it('is the base64 sha256 of the exact text', () => {
    const expected = createHash('sha256')
      .update('a{b:c}', 'utf8')
      .digest('base64');
    expect(cspHashOf('a{b:c}')).toBe(`sha256-${expected}`);
  });
});

describe('the frame headers', () => {
  const headers = frameHeaders();

  it('keep crawlers out and allow framing by this origin only', () => {
    expect(headers['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(headers['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(headers['Content-Security-Policy']).toBe("frame-ancestors 'self'");
  });

  it('are an html response that is never sniffed and keeps referrers on this origin', () => {
    expect(headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('same-origin');
  });
});

describe('the shell headers and policy', () => {
  it('forbid framing by anyone and keep crawlers and referrers out', () => {
    const headers = cmsDocumentHeaders({ csp: true });
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Content-Security-Policy']).toContain(
      "frame-ancestors 'none'",
    );
  });

  it('send no policy when it is switched off', () => {
    expect(
      cmsDocumentHeaders({ csp: false })['Content-Security-Policy'],
    ).toBeUndefined();
  });

  it('allows only this origin plus the listed hashes, with no unsafe-inline', () => {
    const policy = buildShellCsp({
      csp: true,
      scriptHashes: ['sha256-script'],
      styleHashes: ['sha256-one', 'sha256-two'],
    });
    expect(policy).toBe(
      [
        "default-src 'self'",
        "script-src 'self' 'sha256-script'",
        "style-src 'self' 'sha256-one' 'sha256-two'",
        "img-src 'self' data:",
        "frame-src 'self'",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    expect(policy).not.toContain('unsafe-inline');
  });

  it('lists no hash source when none is given', () => {
    const policy = buildShellCsp({ csp: true });
    expect(policy).toContain("script-src 'self';");
    expect(policy).toContain("style-src 'self';");
  });
});

describe('buildCmsDocument', () => {
  it('writes a complete noindex document and escapes the title', () => {
    const html = buildCmsDocument({
      title: '<b>x</b>',
      headHtml: '<style>a{}</style>',
      bodyHtml: '<p>body</p>',
    });
    expect(html.startsWith('<!DOCTYPE html><html lang="en"><head>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('<title>&lt;b&gt;x&lt;/b&gt;</title>');
    expect(html).toContain('<style>a{}</style></head><body><p>body</p></body>');
  });
});
