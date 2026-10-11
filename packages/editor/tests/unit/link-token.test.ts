/**
 * Reading the token out of an emailed link: once, and the address bar, the
 * history entry and with them the Referer of anything the page loads next are
 * left without it.
 */
import { describe, expect, it } from 'vitest';
import {
  takeLinkToken,
  type LinkTokenEnvironment,
} from '../../src/client/login/link-token.js';

type Replacement = { readonly state: unknown; readonly url: string };

/** A location and history that remember what was replaced, like the browser's. */
function fakeBrowser(address: string): {
  readonly env: LinkTokenEnvironment;
  readonly replacements: Replacement[];
} {
  const replacements: Replacement[] = [];
  const location = { href: address };
  const env: LinkTokenEnvironment = {
    location,
    history: {
      state: { marker: 'kept' },
      replaceState(state: unknown, _unused: string, url?: string | URL | null) {
        const resolved = new URL(String(url), location.href);
        replacements.push({ state, url: String(url) });
        location.href = resolved.href;
      },
    },
  };
  return { env, replacements };
}

describe('takeLinkToken', () => {
  it('returns the token and replaces the history entry without it, keeping next', () => {
    const { env, replacements } = fakeBrowser(
      'https://site.test/cms/reset-password?token=abc&next=%2Fabout',
    );
    expect(takeLinkToken(env)).toBe('abc');
    expect(replacements).toEqual([
      {
        state: { marker: 'kept' },
        url: '/cms/reset-password?next=%2Fabout',
      },
    ]);
    expect(env.location.href).toBe(
      'https://site.test/cms/reset-password?next=%2Fabout',
    );
  });

  it('returns null the second time', () => {
    const { env, replacements } = fakeBrowser(
      'https://site.test/cms/set-password?token=abc',
    );
    expect(takeLinkToken(env)).toBe('abc');
    expect(takeLinkToken(env)).toBeNull();
    expect(replacements).toHaveLength(1);
  });

  it('leaves history alone when the address carries no token', () => {
    const { env, replacements } = fakeBrowser(
      'https://site.test/cms/reset-password?next=%2Fabout',
    );
    expect(takeLinkToken(env)).toBeNull();
    expect(replacements).toEqual([]);
  });

  it('keeps the fragment and every other parameter', () => {
    const { env, replacements } = fakeBrowser(
      'https://site.test/cms/reset-password?a=1&token=t%2B1&b=2#top',
    );
    expect(takeLinkToken(env)).toBe('t+1');
    expect(replacements[0]?.url).toBe('/cms/reset-password?a=1&b=2#top');
  });

  it('removes an empty token and answers null for it', () => {
    const { env, replacements } = fakeBrowser(
      'https://site.test/cms/reset-password?token=&next=%2Fabout',
    );
    expect(takeLinkToken(env)).toBeNull();
    expect(replacements[0]?.url).toBe('/cms/reset-password?next=%2Fabout');
  });

  it('removes a repeated token parameter entirely and uses the first', () => {
    const { env, replacements } = fakeBrowser(
      'https://site.test/cms/reset-password?token=one&token=two',
    );
    expect(takeLinkToken(env)).toBe('one');
    expect(replacements[0]?.url).toBe('/cms/reset-password');
  });
});
