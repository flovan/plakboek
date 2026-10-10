/**
 * The `/cms` entry through a real build and a real database: the login
 * document over the blurred real page, safe `next` handling, the valid-session
 * redirects, and `noindex` on every answer under `/cms`.
 */
import { randomUUID } from 'node:crypto';
import { createUserWithRole } from '@plakboek/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_CLIENT_DIR, FIXTURE_SERVER_ENTRY } from './fixture-host.js';
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
});
