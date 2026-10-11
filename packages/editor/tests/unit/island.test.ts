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
    expect(readIsland(sourceOf(escapeJsonForHtml(hostile)))).toMatchObject({
      user: { name: '</script> ' },
    });
  });

  it('reads the read-only mode', () => {
    expect(
      readIsland(sourceOf(JSON.stringify({ ...VALID, mode: 'read-only' }))),
    ).toMatchObject({ mode: 'read-only' });
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
    ['an unknown kind', JSON.stringify({ ...VALID, kind: 'sidebar' })],
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

const LOGIN = {
  kind: 'login',
  step: 'sign-in',
  next: '/about',
  passwordMinLength: 12,
};

describe('readIsland for the login document', () => {
  it('reads a login island exactly as the server wrote it', () => {
    expect(readIsland(sourceOf(escapeJsonForHtml(LOGIN)))).toEqual(LOGIN);
  });

  it('reads the optional link kind and email', () => {
    const island = {
      ...LOGIN,
      step: 'invalid-link',
      linkKind: 'reset',
      email: 'ada@example.com',
    };
    expect(readIsland(sourceOf(JSON.stringify(island)))).toEqual(island);
  });

  it('keeps only the known fields', () => {
    expect(
      readIsland(sourceOf(JSON.stringify({ ...LOGIN, token: 'secret' }))),
    ).toEqual(LOGIN);
  });

  it.each([
    ['an unknown step', { ...LOGIN, step: 'admin' }],
    ['a missing next', { ...LOGIN, next: undefined }],
    ['a non-text next', { ...LOGIN, next: 4 }],
    [
      'a missing minimum password length',
      { ...LOGIN, passwordMinLength: undefined },
    ],
    [
      'a minimum that is not a whole number',
      { ...LOGIN, passwordMinLength: 12.5 },
    ],
    ['a minimum that is not positive', { ...LOGIN, passwordMinLength: 0 }],
    [
      'a minimum that is absurdly large',
      { ...LOGIN, passwordMinLength: 100000 },
    ],
    ['a minimum written as text', { ...LOGIN, passwordMinLength: '12' }],
    ['an unknown link kind', { ...LOGIN, linkKind: 'magic' }],
    ['a non-text email', { ...LOGIN, email: 5 }],
  ])('returns null for %s', (_label, island) => {
    expect(readIsland(sourceOf(JSON.stringify(island)))).toBeNull();
  });
});
