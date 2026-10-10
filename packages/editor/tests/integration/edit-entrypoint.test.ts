/**
 * The edit entrypoint over a real database and a real auth instance: who gets
 * the live working tree in the frame, who gets less, and who gets nothing.
 */
import { createVisitorHandler } from '@plakboek/render/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEditEntrypoint } from '../../src/server/entrypoint.js';
import { FRAME_ERROR_MARKER } from '../../src/server/frame-document.js';
import {
  addHeading,
  ANALYTICS_TAG,
  callEntrypoint,
  components,
  composed,
  createHarness,
  createHeadingPage,
  harnessConfig,
  publish,
  renderDocument,
  type Harness,
} from './harness.js';

const ASSETS = { entry: '/assets/editor.js', preload: [], css: [] };

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
  const about = await createHeadingPage(harness, {
    title: 'About',
    text: 'Published heading',
  });
  await publish(harness, about.pageId);
  await addHeading(harness, about, 'Added after publishing');
  await createHeadingPage(harness, {
    title: 'Draft only',
    text: 'Never published',
  });
});

afterAll(async () => {
  await harness.close();
});

function entrypoint(
  overrides: Partial<Parameters<typeof createEditEntrypoint>[0]> = {},
): ReturnType<typeof createEditEntrypoint> {
  return createEditEntrypoint({
    auth: harness.auth,
    resolver: harness.resolver,
    db: harness.handle.db,
    pages: { config: harnessConfig, homeSlug: 'home' },
    components,
    renderDocument,
    assets: ASSETS,
    csp: true,
    ...overrides,
  });
}

function cookieOf(user: { readonly cookie: string }): { cookie: string } {
  return { cookie: user.cookie };
}

function expectEditHeaders(response: Response): void {
  expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
  expect(response.headers.get('Content-Security-Policy')).toBe(
    "frame-ancestors 'self'",
  );
}

describe('the frame for a user who can edit', () => {
  it('renders the live working tree through the host document in edit mode, with live attributes', async () => {
    composed.length = 0;
    const response = await callEntrypoint(
      entrypoint(),
      '/about?_edit=frame',
      cookieOf(harness.editor),
    );
    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    expectEditHeaders(response!);
    const html = await response!.text();
    expect(composed).toEqual([{ mode: 'edit', publicPath: '/about' }]);
    expect(html).toContain('data-pk-block=');
    expect(html).toContain('Published heading');
    expect(html).toContain('Added after publishing');
    expect(html).toContain('data-pk-kind="section"');
  });

  it('adds nothing to the site document beyond what the host rendered and the live attributes', async () => {
    const response = await callEntrypoint(
      entrypoint(),
      '/about?_edit=frame',
      cookieOf(harness.editor),
    );
    const html = await response!.text();
    expect(html).not.toContain('<script');
    expect(html).not.toContain('plakboek-editor');
    expect(html).not.toContain('<style');
    expect(html).not.toContain(ANALYTICS_TAG);
  });

  it('renders a page that was never published', async () => {
    const response = await callEntrypoint(
      entrypoint(),
      '/draft-only?_edit=frame',
      cookieOf(harness.editor),
    );
    expect(response?.status).toBe(200);
    expect(await response!.text()).toContain('Never published');
  });

  it('keeps the query string out of the page lookup', async () => {
    const response = await callEntrypoint(
      entrypoint(),
      '/about?utm=x&_edit=frame',
      cookieOf(harness.editor),
    );
    expect(response?.status).toBe(200);
  });
});

describe('the frame for a user who cannot edit', () => {
  it('shows a viewer the published page only, with no live attribute', async () => {
    const response = await callEntrypoint(
      entrypoint(),
      '/about?_edit=frame',
      cookieOf(harness.viewer),
    );
    expect(response?.status).toBe(200);
    expectEditHeaders(response!);
    const html = await response!.text();
    expect(html).toContain('Published heading');
    expect(html).not.toContain('Added after publishing');
    expect(html).not.toContain('data-pk-');
  });

  it('answers a viewer 404 for a page that was never published', async () => {
    const response = await callEntrypoint(
      entrypoint(),
      '/draft-only?_edit=frame',
      cookieOf(harness.viewer),
    );
    expect(response?.status).toBe(404);
    expect(await response!.text()).not.toContain('Never published');
  });

  it('shows a drafts reader the working tree as plain markup', async () => {
    const response = await callEntrypoint(
      entrypoint(),
      '/about?_edit=frame',
      cookieOf(harness.drafts),
    );
    expect(response?.status).toBe(200);
    const html = await response!.text();
    expect(html).toContain('Added after publishing');
    expect(html).not.toContain('data-pk-');
  });
});

describe('who gets nothing', () => {
  it('answers null without a session cookie, for both documents', async () => {
    expect(await callEntrypoint(entrypoint(), '/about?_edit=frame')).toBeNull();
    expect(await callEntrypoint(entrypoint(), '/about?_edit=1')).toBeNull();
  });

  it('answers null for a cookie that names no session', async () => {
    const response = await callEntrypoint(entrypoint(), '/about?_edit=frame', {
      cookie: 'better-auth.session_token=forged.value',
    });
    expect(response).toBeNull();
  });

  it('trusts no client signal: the editor flag, a role header and a query value grant nothing', async () => {
    const response = await callEntrypoint(
      entrypoint(),
      '/about?_edit=frame&role=editor',
      {
        'x-plakboek-role': 'superadmin',
        'x-plakboek-editor': '1',
        cookie: 'plakboek:editor=1',
      },
    );
    expect(response).toBeNull();
  });

  it('answers null for the frame of a superadmin who has not enrolled', async () => {
    expect(
      await callEntrypoint(
        entrypoint(),
        '/about?_edit=frame',
        cookieOf(harness.superadmin),
      ),
    ).toBeNull();
  });
});

describe('frame requests that are not a plain render', () => {
  it('sends a top-level load of a frame URL to the shell for the same page', async () => {
    const response = await callEntrypoint(
      entrypoint(),
      '/about?utm=x&_edit=frame',
      { ...cookieOf(harness.editor), 'sec-fetch-dest': 'document' },
    );
    expect(response?.status).toBe(302);
    expect(response?.headers.get('Location')).toBe('/about?utm=x&_edit=1');
  });

  it('is not redirected when the browser says the destination is an iframe', async () => {
    const response = await callEntrypoint(entrypoint(), '/about?_edit=frame', {
      ...cookieOf(harness.editor),
      'sec-fetch-dest': 'iframe',
    });
    expect(response?.status).toBe(200);
  });

  it('redirects a non-canonical path to the canonical frame path, keeping the query', async () => {
    const response = await callEntrypoint(
      entrypoint(),
      '/About?utm=x&_edit=frame',
      cookieOf(harness.editor),
    );
    expect(response?.status).toBe(302);
    expect(response?.headers.get('Location')).toBe('/about?utm=x&_edit=frame');
  });

  it('answers the host not-found document inside the frame for an unknown path', async () => {
    const notFound = vi.fn(
      () => new Response('<html><body>Host not found</body></html>'),
    );
    const response = await callEntrypoint(
      entrypoint({ notFound }),
      '/missing?_edit=frame',
      cookieOf(harness.editor),
    );
    expect(response?.status).toBe(404);
    expectEditHeaders(response!);
    expect(await response!.text()).toContain('Host not found');
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it('answers a minimal not-found document when the host set none', async () => {
    const response = await callEntrypoint(
      entrypoint(),
      '/missing/deeply/nested?_edit=frame',
      cookieOf(harness.editor),
    );
    expect(response?.status).toBe(404);
  });

  it('answers a path that is not a page address with 404 and no lookup', async () => {
    const response = await callEntrypoint(
      entrypoint(),
      '/a%20b?_edit=frame',
      cookieOf(harness.editor),
    );
    expect(response?.status).toBe(404);
  });
});

describe('a render that fails', () => {
  it('answers 500 with the marker and nothing about the error, reporting the error type only', async () => {
    const onRenderError = vi.fn();
    const response = await callEntrypoint(
      entrypoint({
        renderDocument: () => {
          throw new Error('secret failure detail: /srv/db password');
        },
        hooks: { onRenderError },
      }),
      '/about?_edit=frame',
      cookieOf(harness.editor),
    );
    expect(response?.status).toBe(500);
    expectEditHeaders(response!);
    const html = await response!.text();
    expect(html).toContain(
      `<meta name="${FRAME_ERROR_MARKER}" content="render">`,
    );
    expect(html).not.toContain('secret failure detail');
    expect(html).not.toContain('Error');
    expect(html).not.toMatch(/\bat\s+\S+\s+\(/);
    expect(onRenderError).toHaveBeenCalledTimes(1);
  });

  it('logs the error name and never its message when the host set no hook', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await callEntrypoint(
        entrypoint({
          renderDocument: () => {
            throw new TypeError('secret failure detail');
          },
        }),
        '/about?_edit=frame',
        cookieOf(harness.editor),
      );
      expect(spy).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).toContain('TypeError');
      expect(logged).not.toContain('secret failure detail');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('through the visitor handler', () => {
  it('serves the frame as private, no-store and bounces an anonymous request to the plain page', async () => {
    const handler = createVisitorHandler({
      db: harness.handle.db,
      config: harnessConfig,
      renderDocument,
      edit: entrypoint(),
    });
    const anonymous = await handler(
      new Request('http://site.test/about?_edit=frame'),
    );
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get('Location')).toBe('/about');

    const signedIn = await handler(
      new Request('http://site.test/about?_edit=frame', {
        headers: cookieOf(harness.editor),
      }),
    );
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get('Cache-Control')).toBe('private, no-store');
    expect(signedIn.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(await signedIn.text()).toContain('data-pk-block=');
  });

  it('still serves a visitor the cached-style published page with analytics, unchanged', async () => {
    const handler = createVisitorHandler({
      db: harness.handle.db,
      config: harnessConfig,
      renderDocument,
      edit: entrypoint(),
    });
    const visitor = await handler(new Request('http://site.test/about'));
    const html = await visitor.text();
    expect(html).toContain(ANALYTICS_TAG);
    expect(html).not.toContain('Added after publishing');
    expect(html).not.toContain('data-pk-');
  });
});
