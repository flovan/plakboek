/**
 * The editor API over a real database and a real auth instance: opening a
 * page gives the session an editor starts with and takes the lock, the gate
 * refuses what it should, and the lock endpoints keep, release and take over
 * a page's lock.
 */
import { setPageEditLocking } from '@plakboek/pages';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiError,
  EditorSession,
  LockResponse,
  TreeResponse,
} from '../../src/api-types.js';
import { createEditorApi } from '../../src/server/api/handler.js';
import { createEditEntrypoint } from '../../src/server/entrypoint.js';
import {
  apiConfig,
  apiRequest,
  components,
  createApiHarness,
  createColumnPage,
  createFlatPage,
  SITE_ORIGIN,
  type ApiHarness,
  type ApiRequestOptions,
  type SignedIn,
} from './api-harness.js';

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(() => {
  harness.clock.reset();
});

function api(): ReturnType<typeof createEditorApi> {
  return createEditorApi({
    auth: harness.auth,
    resolver: harness.resolver,
    pages: harness.pagesDeps,
    homeSlug: 'home',
    components,
    siteOrigin: SITE_ORIGIN,
  });
}

async function call(
  path: string,
  options: ApiRequestOptions,
): Promise<Response> {
  const response = await api().handle(apiRequest(path, options));
  if (response === null) throw new Error(`the API ignored ${path}`);
  return response;
}

async function open(
  user: SignedIn | undefined,
  path: string,
): Promise<Response> {
  return await call('/cms/api/open', { user, method: 'POST', body: { path } });
}

async function lockCall(
  user: SignedIn,
  pageId: string,
  action: 'acquire' | 'renew' | 'release' | 'take-over',
): Promise<Response> {
  return await call(`/cms/api/pages/${pageId}/lock/${action}`, {
    user,
    method: 'POST',
  });
}

async function readSession(response: Response): Promise<EditorSession> {
  expect(response.status).toBe(200);
  return (await response.json()) as EditorSession;
}

async function readError(response: Response): Promise<ApiError['error']> {
  const body = (await response.json()) as ApiError;
  expect(body.ok).toBe(false);
  return body.error;
}

describe('opening a page', () => {
  it('gives an editor the session, the column-shaped tree and the lock', async () => {
    const seeded = await createColumnPage(harness, {
      title: 'About',
      text: 'Hello',
    });
    const response = await open(harness.editor, '/about');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toContain('application/json');
    const session = await readSession(response);

    expect(session.pageId).toBe(seeded.pageId);
    expect(session.locale).toBe('en');
    expect(session.pageVersion).toBeGreaterThan(0);
    expect(session.upgraded).toBe(false);
    expect(session.canDelete).toBe(true);
    expect(session.columnsEnabled).toBe(true);
    expect(
      session.tree.map((node) => [node.type, node.kind, node.depth]),
    ).toEqual([
      ['section', 'section', 0],
      ['column', 'column', 1],
      ['heading', 'block', 2],
    ]);
    expect(session.tree[2]?.parentId).toBe(seeded.columnId);
    expect(session.tree[2]?.props).toEqual({ text: 'Hello' });
    expect(session.lock.state).toBe('mine');
    expect(session.lock.enabled).toBe(true);
    expect(session.lock.holder).toBeNull();
    expect(typeof session.lock.expiresAt).toBe('string');
    expect(session.limits.heartbeatSeconds).toBeGreaterThan(0);
    expect(session.columnPresets).toContain('1:2');
  });

  it('builds the catalogue on the server and leaves hidden properties out', async () => {
    await createColumnPage(harness, { title: 'Catalogue', text: 'x' });
    const session = await readSession(await open(harness.editor, '/catalogue'));

    expect(session.catalogue.map((entry) => entry.key)).toEqual(
      apiConfig.blocks.map((block) => block.key),
    );
    const heading = session.catalogue.find((entry) => entry.key === 'heading');
    expect(heading?.properties.map((property) => property.key)).toEqual([
      'text',
    ]);
    expect(heading?.properties[0]?.required).toBe(true);
    expect(heading?.editor.category).toBe('Text');
    expect(
      session.catalogue.find((entry) => entry.key === 'quote')?.supportsFill,
    ).toBe(true);
  });

  it('flags a required property that is still empty', async () => {
    await createColumnPage(harness, { title: 'Empty', text: null });
    const session = await readSession(await open(harness.editor, '/empty'));
    const heading = session.tree.find((node) => node.type === 'heading');
    expect(heading?.needsInput).toEqual(['text']);
    expect(
      session.tree.find((node) => node.type === 'section')?.needsInput,
    ).toEqual([]);
  });

  it('brings a page that predates columns into the column shape', async () => {
    await createFlatPage(harness, { title: 'Flat', text: 'Old' });
    const session = await readSession(await open(harness.editor, '/flat'));
    expect(session.upgraded).toBe(true);
    expect(session.tree.map((node) => node.type)).toEqual([
      'section',
      'column',
      'heading',
    ]);
    const again = await readSession(await open(harness.editor, '/flat'));
    expect(again.upgraded).toBe(false);
  });

  it('answers 404 for a page that does not exist', async () => {
    const response = await open(harness.editor, '/nothing-here');
    expect(response.status).toBe(404);
    expect((await readError(response)).code).toBe('not-found');
  });

  it('reports a lock held by someone else without taking it, and without naming more than the display name', async () => {
    const seeded = await createColumnPage(harness, {
      title: 'Shared',
      text: 'x',
    });
    await readSession(await open(harness.editor, '/shared'));

    // Same role: the superset rule lets this editor take the page over.
    const peer = await open(harness.editor2, '/shared');
    const peerText = await peer.clone().text();
    const peerSession = await readSession(peer);
    expect(peerSession.lock.state).toBe('other');
    expect(peerSession.lock.holder?.name).toBe('Editor');
    expect(typeof peerSession.lock.holder?.lastActiveAt).toBe('string');
    expect(peerSession.lock.canTakeOver).toBe(true);
    expect(peerSession.lock.expiresAt).toBeNull();

    // A role with fewer permissions may not.
    const lesser = await open(harness.limited, '/shared');
    const lesserText = await lesser.clone().text();
    const lesserSession = await readSession(lesser);
    expect(lesserSession.lock.state).toBe('other');
    expect(lesserSession.lock.canTakeOver).toBe(false);

    for (const text of [peerText, lesserText]) {
      expect(text).not.toContain(harness.editor.email);
      expect(text).not.toContain(harness.editor.userId);
      expect(text).not.toContain('"role');
    }
    expect(Object.keys(peerSession.lock).toSorted()).toEqual([
      'canTakeOver',
      'enabled',
      'expiresAt',
      'holder',
      'state',
    ]);
    expect(Object.keys(peerSession.lock.holder ?? {}).toSorted()).toEqual([
      'lastActiveAt',
      'name',
    ]);

    // Nothing was taken: the first editor still holds the lock.
    const first = await call(`/cms/api/pages/${seeded.pageId}/lock`, {
      user: harness.editor,
    });
    expect(((await first.json()) as LockResponse).lock.state).toBe('mine');
  });
});

describe('the request gate', () => {
  it('answers 401 without a session', async () => {
    await createColumnPage(harness, { title: 'Gate one', text: 'x' });
    const response = await open(undefined, '/gate-one');
    expect(response.status).toBe(401);
    expect((await readError(response)).code).toBe('unauthenticated');
  });

  it('answers 403 to a user who may not edit pages', async () => {
    await createColumnPage(harness, { title: 'Gate two', text: 'x' });
    const response = await open(harness.viewer, '/gate-two');
    expect(response.status).toBe(403);
    expect((await readError(response)).code).toBe('forbidden');
  });

  it('answers 403 to a post from another site', async () => {
    await createColumnPage(harness, { title: 'Gate three', text: 'x' });
    const response = await call('/cms/api/open', {
      user: harness.editor,
      method: 'POST',
      body: { path: '/gate-three' },
      origin: 'https://evil.test',
    });
    expect(response.status).toBe(403);
    expect((await readError(response)).code).toBe('forbidden');
  });

  it('answers 415 to a body that is not JSON', async () => {
    await createColumnPage(harness, { title: 'Gate four', text: 'x' });
    const response = await api().handle(
      apiRequest('/cms/api/open', {
        user: harness.editor,
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: undefined,
      }),
    );
    expect(response?.status).toBe(415);
  });

  it('answers 400 with keys and codes for a body that fails validation', async () => {
    const response = await call('/cms/api/open', {
      user: harness.editor,
      method: 'POST',
      body: { path: 'no-leading-slash' },
    });
    expect(response.status).toBe(400);
    const error = await readError(response);
    expect(error.code).toBe('invalid-request');
    expect(error.issues?.[0]?.key).toBe('path');
  });

  it('ignores a path outside the API and answers JSON 404 inside it', async () => {
    expect(await api().handle(new Request(`${SITE_ORIGIN}/about`))).toBeNull();
    const response = await call('/cms/api/unknown', { user: harness.editor });
    expect(response.status).toBe(404);
    expect((await readError(response)).code).toBe('not-found');
  });
});

describe('the lock endpoints', () => {
  it('shows a second editor a renewed heartbeat', async () => {
    const seeded = await createColumnPage(harness, {
      title: 'Beat',
      text: 'x',
    });
    await open(harness.editor, '/beat');
    const before = (await (
      await call(`/cms/api/pages/${seeded.pageId}/lock`, {
        user: harness.editor2,
      })
    ).json()) as LockResponse;

    harness.clock.advance(30_000);
    const renewed = await lockCall(harness.editor, seeded.pageId, 'renew');
    expect(((await renewed.json()) as LockResponse).lock.state).toBe('mine');

    const after = (await (
      await call(`/cms/api/pages/${seeded.pageId}/lock`, {
        user: harness.editor2,
      })
    ).json()) as LockResponse;
    expect(after.lock.holder?.lastActiveAt).not.toBe(
      before.lock.holder?.lastActiveAt,
    );
    expect(Date.parse(after.lock.holder?.lastActiveAt ?? '')).toBeGreaterThan(
      Date.parse(before.lock.holder?.lastActiveAt ?? ''),
    );
  });

  it('frees the page on release so a second editor can take it', async () => {
    const seeded = await createColumnPage(harness, {
      title: 'Handover',
      text: 'x',
    });
    await open(harness.editor, '/handover');
    const released = await lockCall(harness.editor, seeded.pageId, 'release');
    expect(((await released.json()) as LockResponse).lock.state).toBe('free');

    const acquired = await lockCall(harness.editor2, seeded.pageId, 'acquire');
    expect(((await acquired.json()) as LockResponse).lock.state).toBe('mine');
    const blocked = await lockCall(harness.editor, seeded.pageId, 'acquire');
    expect(blocked.status).toBe(423);
    const error = await readError(blocked);
    expect(error.code).toBe('locked');
    expect(error.lock?.state).toBe('other');
    expect(error.lock?.holder?.name).toBe('Editor2');
  });

  it('lets a superadmin take over from an editor, who then finds the page locked', async () => {
    const seeded = await createColumnPage(harness, {
      title: 'Takeover',
      text: 'x',
    });
    await open(harness.editor, '/takeover');

    const taken = await lockCall(
      harness.superadmin,
      seeded.pageId,
      'take-over',
    );
    expect(taken.status).toBe(200);
    expect(((await taken.json()) as LockResponse).lock.state).toBe('mine');

    const renewed = await lockCall(harness.editor, seeded.pageId, 'renew');
    expect(renewed.status).toBe(423);
    const error = await readError(renewed);
    expect(error.code).toBe('locked');
    expect(error.lock?.holder?.name).toBe('Owner');
  });

  it('refuses a takeover by a role that is not a superset of the holder', async () => {
    const seeded = await createColumnPage(harness, {
      title: 'Refused',
      text: 'x',
    });
    await open(harness.superadmin, '/refused');
    const response = await lockCall(harness.editor, seeded.pageId, 'take-over');
    expect(response.status).toBe(403);
    expect((await readError(response)).code).toBe('forbidden');
  });

  it('opens without a lock and refuses to acquire one while locking is off', async () => {
    const seeded = await createColumnPage(harness, {
      title: 'Unlocked',
      text: 'x',
    });
    await setPageEditLocking(harness.pagesDeps, harness.actor, {
      enabled: false,
    });
    try {
      const session = await readSession(
        await open(harness.editor, '/unlocked'),
      );
      expect(session.lock.enabled).toBe(false);
      expect(session.lock.state).toBe('free');

      const acquire = await lockCall(harness.editor, seeded.pageId, 'acquire');
      expect(acquire.status).toBe(409);
      expect((await readError(acquire)).code).toBe('locking-disabled');
    } finally {
      await setPageEditLocking(harness.pagesDeps, harness.actor, {
        enabled: true,
      });
    }
  });

  it('reads the current tree', async () => {
    const seeded = await createColumnPage(harness, {
      title: 'Tree read',
      text: 'Now',
    });
    const response = await call(`/cms/api/pages/${seeded.pageId}/tree`, {
      user: harness.editor,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as TreeResponse;
    expect(body.ok).toBe(true);
    expect(body.tree.map((node) => node.type)).toEqual([
      'section',
      'column',
      'heading',
    ]);
    expect(body.tree[2]?.props).toEqual({ text: 'Now' });
  });

  it('answers 404 for a page id that does not exist and 400 for one that is not an id', async () => {
    const missing = await call(
      '/cms/api/pages/00000000-0000-4000-8000-000000000000/tree',
      { user: harness.editor },
    );
    expect(missing.status).toBe(404);
    const malformed = await call('/cms/api/pages/not-an-id/tree', {
      user: harness.editor,
    });
    expect(malformed.status).toBe(400);
  });
});

describe('the frame', () => {
  it('marks a column cell as a column for an editor', async () => {
    await createColumnPage(harness, { title: 'Framed', text: 'x' });
    const entrypoint = createEditEntrypoint({
      auth: harness.auth,
      resolver: harness.resolver,
      db: harness.handle.db,
      pages: { config: apiConfig, homeSlug: 'home' },
      components,
      renderDocument: (input) =>
        `<!DOCTYPE html><html><head></head><body>${input.body}</body></html>`,
      assets: { entry: '/assets/editor.js', preload: [], css: [] },
      csp: true,
    });
    const url = new URL(`${SITE_ORIGIN}/framed?_edit=frame`);
    const response = await entrypoint(
      new Request(url, { headers: { cookie: harness.editor.cookie } }),
      { url, visitorLocation: '/framed' },
    );
    expect(response?.status).toBe(200);
    const html = (await response?.text()) ?? '';
    expect(html).toContain('data-pk-kind="column"');
    expect(html).toContain('data-pk-kind="section"');
  });
});
