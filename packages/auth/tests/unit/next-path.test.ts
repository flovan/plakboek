import { describe, expect, it } from 'vitest';
import { sanitizeNextPath } from '../../src/next-path.js';

describe('sanitizeNextPath (D-09)', () => {
  const HOSTILE: readonly (readonly [label: string, input: unknown])[] = [
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
    ['an object', { toString: () => '/about' }],
    ['the empty string', ''],
    ['a relative word', 'about'],
    ['an absolute URL', 'https://evil.test/x'],
    ['a protocol-relative URL', '//evil.test'],
    ['a slash-backslash host', '/\\evil.test'],
    ['an encoded CRLF', '/%0d%0aSet-Cookie:x'],
    ['an encoded newline in the query', '/a?b=%0Ac'],
    ['an encoded backslash', '/%5Cevil.test'],
    ['a raw control character', '/a\u0007b'],
    ['a raw newline', '/a\nb'],
    ['a backslash inside the path', '/a\\b'],
    ['a 2049-character path', `/${'a'.repeat(2048)}`],
    ['/cms', '/cms'],
    ['/cms/x', '/cms/x'],
    ['/CMS', '/CMS'],
    ['/Cms/', '/Cms/'],
    ['an encoded /cms', '/%63ms/x'],
    ['/cms through dot segments', '/a/../cms/x'],
    ['/api/auth/x', '/api/auth/x'],
    ['/API', '/API'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,x'],
    ['a malformed percent escape', '/%zz'],
  ];

  it.each(HOSTILE)('answers / for %s', (_label, input) => {
    expect(sanitizeNextPath(input as string | null | undefined)).toBe('/');
  });

  it('keeps an ordinary same-origin path unchanged', () => {
    expect(sanitizeNextPath('/')).toBe('/');
    expect(sanitizeNextPath('/nl/over-ons')).toBe('/nl/over-ons');
    expect(sanitizeNextPath('/about?a=b&c=d%20e')).toBe('/about?a=b&c=d%20e');
  });

  it('accepts a path of exactly 2048 characters', () => {
    const path = `/${'a'.repeat(2047)}`;
    expect(sanitizeNextPath(path)).toBe(path);
  });

  it('does not treat a path that only starts with cms or api as reserved', () => {
    expect(sanitizeNextPath('/cmsx')).toBe('/cmsx');
    expect(sanitizeNextPath('/apiary/bees')).toBe('/apiary/bees');
    expect(sanitizeNextPath('/about/cms')).toBe('/about/cms');
  });

  it('strips every _edit parameter and keeps the rest', () => {
    expect(sanitizeNextPath('/about?_edit=1&a=b')).toBe('/about?a=b');
    expect(sanitizeNextPath('/about?a=b&_edit=frame&_edit=1')).toBe(
      '/about?a=b',
    );
    expect(sanitizeNextPath('/about?_edit=1')).toBe('/about');
    expect(sanitizeNextPath('/about?%5Fedit=1&a=b')).toBe('/about?a=b');
  });

  it('collapses runs of slashes inside the path', () => {
    expect(sanitizeNextPath('/a//b')).toBe('/a/b');
    expect(sanitizeNextPath('/a///b//c')).toBe('/a/b/c');
  });

  it('drops a fragment', () => {
    expect(sanitizeNextPath('/about#team')).toBe('/about');
  });

  it('never returns something that could leave the origin', () => {
    for (const input of [
      '/a//evil.test',
      '/./\\evil.test',
      '/%2F%2Fevil.test',
    ]) {
      const result = sanitizeNextPath(input);
      expect(result.startsWith('/')).toBe(true);
      expect(result.startsWith('//')).toBe(false);
      expect(result.startsWith('/\\')).toBe(false);
    }
  });
});
