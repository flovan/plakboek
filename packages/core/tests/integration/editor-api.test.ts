/**
 * The editor's JSON API through a real build and a real server: a signed-in
 * editor opens the home page, reads its tree and keeps its lock, a request
 * from another site is refused, and every answer under `/cms/api` carries the
 * `/cms` headers.
 */
import { randomUUID } from 'node:crypto';
import { createUserWithRole } from '@plakboek/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_CLIENT_DIR, FIXTURE_SERVER_ENTRY } from './fixture-host.js';
import { createInstallation, type Installation } from './installation.js';

const SITE_ORIGIN = 'http://localhost:3000';
const EDITOR = {
  name: 'Edith Editor',
  email: 'edith@example.com',
  password: 'an editor passphrase 2026',
};

type TreeNode = { id: string; type: string; kind: string };
type Session = {
  ok: true;
  pageId: string;
  tree: TreeNode[];
  lock: { state: string };
};

describe('the /cms/api route', () => {
  let installation: Installation;
  let url: (path: string) => string;
  let cookie: string;

  function call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Cookie', cookie);
    return fetch(url(path), { ...init, headers });
  }

  function post(path: string, body: unknown, origin = SITE_ORIGIN) {
    return call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(body),
    });
  }

  function expectCmsHeaders(response: Response): void {
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
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
    const served = await installation.serve({
      serverEntry: FIXTURE_SERVER_ENTRY,
      clientDir: FIXTURE_CLIENT_DIR,
    });
    url = served.url;
    const response = await fetch(url('/api/auth/sign-in/email'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: SITE_ORIGIN },
      body: JSON.stringify({ email: EDITOR.email, password: EDITOR.password }),
    });
    if (response.status !== 200) {
      throw new Error(`sign-in answered ${String(response.status)}`);
    }
    cookie = response.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0])
      .join('; ');
  });

  afterAll(async () => {
    await installation?.dispose();
  });

  it('opens the home page, reads its tree and renews its lock', async () => {
    const opened = await post('/cms/api/open', { path: '/' });
    expect(opened.status).toBe(200);
    expectCmsHeaders(opened);
    const session = (await opened.json()) as Session;
    expect(session.lock.state).toBe('mine');
    const section = session.tree.find((node) => node.type === 'section');
    expect(section).toBeDefined();
    expect(session.tree.some((node) => node.kind === 'column')).toBe(true);

    const tree = await call(`/cms/api/pages/${session.pageId}/tree`);
    expect(tree.status).toBe(200);
    expectCmsHeaders(tree);
    const read = (await tree.json()) as { tree: TreeNode[] };
    expect(read.tree.map((node) => node.id)).toEqual(
      session.tree.map((node) => node.id),
    );

    const renewed = await post(
      `/cms/api/pages/${session.pageId}/lock/renew`,
      {},
    );
    expect(renewed.status).toBe(200);
    expectCmsHeaders(renewed);
    expect(((await renewed.json()) as Session).lock.state).toBe('mine');
  });

  it('refuses a state-changing request from another site', async () => {
    const response = await post(
      '/cms/api/open',
      { path: '/' },
      'https://evil.test',
    );
    expect(response.status).toBe(403);
    expectCmsHeaders(response);
  });

  it('answers an unknown API path with a JSON 404', async () => {
    const response = await call('/cms/api/unknown');
    expect(response.status).toBe(404);
    expectCmsHeaders(response);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: 'not-found' },
    });
  });

  it('refuses a request without a session, still unindexable', async () => {
    const response = await fetch(url('/cms/api/pages/none/tree'));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expectCmsHeaders(response);
  });
});
