import { describe, expect, it } from 'vitest';
import { readIsland, type IslandSource } from '../../src/client/island.js';
import { ISLAND_ELEMENT_ID } from '../../src/chrome/island.js';
import { escapeJsonForHtml } from '../../src/server/html-document.js';

function sourceOf(content: string | null): IslandSource {
  return {
    getElementById: (id) =>
      id === ISLAND_ELEMENT_ID && content !== null
        ? { textContent: content }
        : null,
  };
}

const VALID = {
  kind: 'shell',
  mode: 'edit',
  user: { name: 'Ada', email: 'ada@example.com' },
  visitorLocation: '/about',
  frameUrl: '/about?_edit=frame',
  logoutPath: '/cms/logout',
};

describe('readIsland', () => {
  it('reads a shell island exactly as the server wrote it', () => {
    expect(readIsland(sourceOf(escapeJsonForHtml(VALID)))).toEqual(VALID);
  });

  it('reads back a hostile name that was escaped for the page', () => {
    const hostile = { ...VALID, user: { name: '</script> ', email: 'a@b' } };
    expect(readIsland(sourceOf(escapeJsonForHtml(hostile)))?.user.name).toBe(
      '</script> ',
    );
  });

  it('reads the read-only mode', () => {
    expect(
      readIsland(sourceOf(JSON.stringify({ ...VALID, mode: 'read-only' })))
        ?.mode,
    ).toBe('read-only');
  });

  it('keeps only the known fields', () => {
    const island = readIsland(
      sourceOf(JSON.stringify({ ...VALID, role: 'superadmin', extra: 1 })),
    );
    expect(island).toEqual(VALID);
  });

  it.each([
    ['a missing element', null],
    ['text that is not JSON', '{nope'],
    ['an array', '[]'],
    ['null', 'null'],
    ['an unknown kind', JSON.stringify({ ...VALID, kind: 'login' })],
    ['an unknown mode', JSON.stringify({ ...VALID, mode: 'admin' })],
    ['a missing user', JSON.stringify({ ...VALID, user: undefined })],
    [
      'a non-text email',
      JSON.stringify({ ...VALID, user: { name: 'a', email: 1 } }),
    ],
    ['a missing frame URL', JSON.stringify({ ...VALID, frameUrl: undefined })],
    ['a non-text location', JSON.stringify({ ...VALID, visitorLocation: 5 })],
    ['a missing logout path', JSON.stringify({ ...VALID, logoutPath: null })],
  ])('returns null for %s', (_label, content) => {
    expect(readIsland(sourceOf(content))).toBeNull();
  });
});
