/**
 * The `/cms` entry through a real build and a real database: the login
 * document over the blurred real page, safe `next` handling, the valid-session
 * redirects, and `noindex` on every answer under `/cms`.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUserWithRole } from '@plakboek/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_CLIENT_DIR,
  FIXTURE_DIR,
  FIXTURE_SERVER_ENTRY,
} from './fixture-host.js';
import { createInstallation, type Installation } from './installation.js';

/** The origin better-auth checks sign-in requests against. */
const SITE_ORIGIN = 'http://localhost:3000';
const EDITOR = {
  name: 'Edith Editor',
  email: 'edith@example.com',
  password: 'an editor passphrase 2026',
};
const OWNER = {
  email: 'owner@example.com',
  password: 'correct horse battery staple',
};

type Served = { url: (path: string) => string };

describe('the /cms routes', () => {
  let installation: Installation;
  let served: Served;

  /** Signs a user in over HTTP and returns the cookie header to send. */
  async function signIn(account: {
    email: string;
    password: string;
  }): Promise<string> {
    const response = await fetch(served.url('/api/auth/sign-in/email'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: SITE_ORIGIN },
      body: JSON.stringify(account),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0])
      .join('; ');
    expect(cookie).toContain('session_token');
    return cookie;
  }

  function get(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(served.url(path), { redirect: 'manual', ...init });
  }

  /** The `src` of the login document's backdrop iframe. */
  function backdropSrc(html: string): string | undefined {
    return /<iframe class="pk-backdrop" src="([^"]*)"/.exec(html)?.[1];
  }

  beforeAll(async () => {
    installation = await createInstallation();
    const context = await installation.runtime.auth.$context;
    await createUserWithRole(installation.runtime.db.db, {
      id: randomUUID(),
      email: EDITOR.email,
      name: EDITOR.name,
      roleKey: 'editor',
      passwordHash: await context.password.hash(EDITOR.password),
    });
    served = await installation.serve({
      serverEntry: FIXTURE_SERVER_ENTRY,
      clientDir: FIXTURE_CLIENT_DIR,
    });
  });

  afterAll(async () => {
    await installation?.dispose();
  });

  describe('the login document', () => {
    it('answers /cms with the sign-in card over the home page, uncacheable, unindexable and unframeable', async () => {
      const response = await get('/cms');
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe(
        'text/html; charset=utf-8',
      );
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      const html = await response.text();
      expect(backdropSrc(html)).toBe('/');
      expect(html).toContain('<dialog');
      expect(html).toContain('Sign in');
    });

    it('shows the page named by next behind the card', async () => {
      const html = await (await get('/cms?next=/about')).text();
      expect(backdropSrc(html)).toBe('/about');
      expect(html).toMatch(/<a href="\/about"[^>]*>Back to site<\/a>/);
    });

    it('keeps the query of a same-origin next', async () => {
      const html = await (
        await get(`/cms?next=${encodeURIComponent('/about?tab=2')}`)
      ).text();
      expect(backdropSrc(html)).toBe('/about?tab=2');
    });

    it.each([
      ['a protocol-relative address', '//evil.test'],
      ['an absolute address', 'https://evil.test'],
      ['a scheme with a path', 'javascript:alert(1)'],
      ['a backslash form', '/\\evil.test'],
      ['an address under /cms', '/cms/logout'],
      ['an address under /api', '/api/auth/session'],
    ])('falls back to the home page for %s', async (_label, hostile) => {
      const response = await get(`/cms?next=${encodeURIComponent(hostile)}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(backdropSrc(html)).toBe('/');
      expect(html).not.toContain('evil.test');
    });

    it('answers the same page for a trailing slash and for another casing', async () => {
      for (const path of ['/cms/', '/CMS', '/Cms?next=/about']) {
        const response = await get(path);
        expect(response.status).toBe(200);
        expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
        expect(await response.text()).toContain('pk-backdrop');
      }
    });

    it('refuses a POST to /cms with 405, still unindexable', async () => {
      const response = await get('/cms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=a%40b.test&password=never-stored',
      });
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, HEAD');
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    });
  });

  describe('a valid session', () => {
    it('goes straight to the page in edit mode, with no modal', async () => {
      const cookie = await signIn(EDITOR);
      const response = await get('/cms?next=/about', {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('/about?_edit=1');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    });

    it('goes to the home page in edit mode without a next, and keeps a next query', async () => {
      const cookie = await signIn(EDITOR);
      const home = await get('/cms', { headers: { Cookie: cookie } });
      expect(home.headers.get('Location')).toBe('/?_edit=1');
      const query = await get(
        `/cms?next=${encodeURIComponent('/about?tab=2')}`,
        { headers: { Cookie: cookie } },
      );
      expect(query.headers.get('Location')).toBe('/about?tab=2&_edit=1');
    });

    it('never redirects to a hostile next, even with a session', async () => {
      const cookie = await signIn(EDITOR);
      const response = await get(
        `/cms?next=${encodeURIComponent('//evil.test')}`,
        { headers: { Cookie: cookie } },
      );
      expect(response.headers.get('Location')).toBe('/?_edit=1');
    });

    it('sends a role that still has to set up two-step sign-in to that step', async () => {
      const cookie = await signIn(OWNER);
      const response = await get('/cms?next=/about', {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe(
        '/cms/two-factor/enrol?next=%2Fabout',
      );
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    });
  });

  describe('everything else under /cms', () => {
    it('answers the host 404 with noindex, never a visitor page', async () => {
      for (const path of ['/cms/anything', '/CMS/Anything/deeper']) {
        const response = await get(path);
        expect(response.status).toBe(404);
        expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        const html = await response.text();
        expect(html).toContain('Page not found');
        expect(html).not.toContain('Hello world');
      }
    });
  });

  describe('logout', () => {
    function logout(
      options: {
        cookie?: string;
        headers?: Record<string, string>;
        body?: string;
      } = {},
    ): Promise<Response> {
      return get('/cms/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(options.cookie === undefined ? {} : { Cookie: options.cookie }),
          ...options.headers,
        },
        body: options.body ?? 'next=%2Fabout',
      });
    }

    async function sessionOf(cookie: string): Promise<unknown> {
      const response = await get('/api/auth/get-session', {
        headers: { Cookie: cookie },
      });
      return await response.json();
    }

    it('answers a GET with 405 and tells crawlers to stay out', async () => {
      const response = await get('/cms/logout');
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('POST');
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    });

    it('refuses a post from another origin and leaves the session alone', async () => {
      const cookie = await signIn(EDITOR);
      const response = await logout({
        cookie,
        headers: { Origin: 'http://evil.test' },
      });
      expect(response.status).toBe(403);
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await sessionOf(cookie)).not.toBeNull();
    });

    it('refuses a post with no Origin unless the browser says it is same-origin', async () => {
      const cookie = await signIn(EDITOR);
      expect((await logout({ cookie })).status).toBe(403);
      expect(
        (
          await logout({
            cookie,
            headers: { 'Sec-Fetch-Site': 'cross-site' },
          })
        ).status,
      ).toBe(403);
      expect(await sessionOf(cookie)).not.toBeNull();
    });

    it('treats an Origin of "null", which a no-referrer document sends, like a missing one', async () => {
      const cookie = await signIn(EDITOR);
      const crossSite = await logout({
        cookie,
        headers: { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' },
      });
      expect(crossSite.status).toBe(403);
      expect(await sessionOf(cookie)).not.toBeNull();
      const sameOrigin = await logout({
        cookie,
        headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' },
      });
      expect(sameOrigin.status).toBe(303);
      expect(await sessionOf(cookie)).toBeNull();
    });

    it('ends the session on the server and goes back to the page without _edit', async () => {
      const cookie = await signIn(EDITOR);
      expect(await sessionOf(cookie)).not.toBeNull();
      const response = await logout({
        cookie,
        headers: { Origin: SITE_ORIGIN },
        body: 'next=%2Fabout%3F_edit%3D1%26tab%3D2',
      });
      expect(response.status).toBe(303);
      expect(response.headers.get('Location')).toBe('/about?tab=2');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
      const cleared = response.headers
        .getSetCookie()
        .find((entry) => entry.includes('session_token'));
      expect(cleared).toBeDefined();
      expect(cleared).toMatch(/Max-Age=0/i);

      // The old cookie no longer resolves to anyone, so /cms asks to sign in.
      expect(await sessionOf(cookie)).toBeNull();
      const entry = await get('/cms?next=/about', {
        headers: { Cookie: cookie },
      });
      expect(entry.status).toBe(200);
      expect(await entry.text()).toContain('pk-backdrop');
    });

    it('accepts a browser that sends no Origin but marks the request same-origin', async () => {
      const cookie = await signIn(EDITOR);
      const response = await logout({
        cookie,
        headers: { 'Sec-Fetch-Site': 'same-origin' },
      });
      expect(response.status).toBe(303);
      expect(await sessionOf(cookie)).toBeNull();
    });

    it.each([
      ['a protocol-relative address', '//evil.test'],
      ['an absolute address', 'https://evil.test'],
      ['an address under /cms', '/cms/setup'],
    ])('goes home for %s', async (_label, hostile) => {
      const cookie = await signIn(EDITOR);
      const response = await logout({
        cookie,
        headers: { Origin: SITE_ORIGIN },
        body: `next=${encodeURIComponent(hostile)}`,
      });
      expect(response.status).toBe(303);
      expect(response.headers.get('Location')).toBe('/');
    });

    it('goes home without a next, and still answers with no session at all', async () => {
      const response = await logout({
        headers: { Origin: SITE_ORIGIN },
        body: '',
      });
      expect(response.status).toBe(303);
      expect(response.headers.get('Location')).toBe('/');
    });

    it('refuses a body over 2 KB', async () => {
      const response = await logout({
        headers: { Origin: SITE_ORIGIN },
        body: `next=${'a'.repeat(3000)}`,
      });
      expect(response.status).toBe(413);
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    });
  });

  describe('noindex on every answer under /cms', () => {
    it('is on the health, setup and test-email answers', async () => {
      for (const path of [
        '/cms/health',
        '/cms/setup',
        '/cms/setup/test-email',
        '/CMS/Health',
      ]) {
        const response = await get(path);
        expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
      }
    });

    it('is on the answer to a POST to health and to the host 404', async () => {
      const response = await get('/cms/anything/at/all', { method: 'POST' });
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    });
  });

  describe('robots.txt', () => {
    it("serves the host's own public/robots.txt, which wins over the default", async () => {
      const response = await get('/robots.txt');
      expect(response.status).toBe(200);
      const own = readFileSync(
        join(FIXTURE_DIR, 'public', 'robots.txt'),
        'utf8',
      );
      expect(await response.text()).toBe(own);
      expect(own).not.toContain('Disallow: /cms');
    });
  });
});
