/**
 * The `/cms` pages handler over a real database and a real auth instance:
 * the sign-in card, every link landing, the enrolment step and the redirects
 * that depend on who is asking.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ISLAND_ELEMENT_ID } from '../../src/chrome/island.js';
import { STRINGS } from '../../src/chrome/strings.js';
import { createCmsPages } from '../../src/server/cms-pages.js';
import { createHarness, SITE_ORIGIN, type Harness } from './harness.js';

const ASSETS = { entry: '/assets/editor.js', preload: [], css: [] };
const TOKEN = 'tok-9f2c71d0a8b44e5c9b1d3e7f6a025c48';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

function pages(): ReturnType<typeof createCmsPages> {
  return createCmsPages({
    auth: harness.auth,
    resolver: harness.resolver,
    assets: ASSETS,
    csp: true,
  });
}

function request(
  pathAndQuery: string,
  options: { cookie?: string; method?: string } = {},
): Request {
  return new Request(`${SITE_ORIGIN}${pathAndQuery}`, {
    method: options.method ?? 'GET',
    headers: options.cookie === undefined ? {} : { cookie: options.cookie },
  });
}

async function page(
  pathAndQuery: string,
  options: { cookie?: string } = {},
): Promise<Response> {
  const response = await pages().handle(request(pathAndQuery, options));
  expect(response).not.toBeNull();
  return response!;
}

/** The island the server wrote, parsed back. */
function islandOf(html: string): Record<string, unknown> {
  const match = new RegExp(
    `<script type="application/json" id="${ISLAND_ELEMENT_ID}">([^]*?)</script>`,
  ).exec(html);
  expect(match).not.toBeNull();
  return JSON.parse(match?.[1] ?? '{}') as Record<string, unknown>;
}

function backdropSrc(html: string): string | undefined {
  return /<iframe class="pk-backdrop" src="([^"]*)"/.exec(html)?.[1];
}

function expectLoginDocument(response: Response): void {
  expect(response.status).toBe(200);
  expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
}

describe('/cms', () => {
  it('shows the sign-in step to anyone without a session', async () => {
    const response = await page('/cms?next=/about');
    expectLoginDocument(response);
    const html = await response.text();
    expect(html).toContain(`>${STRINGS['login.signIn.heading']}</h1>`);
    expect(backdropSrc(html)).toBe('/about');
    expect(islandOf(html)).toEqual({
      kind: 'login',
      step: 'sign-in',
      next: '/about',
      passwordMinLength: 12,
    });
  });

  it('tells the client the minimum password length the installation set', async () => {
    const custom = createCmsPages({
      auth: harness.auth,
      resolver: harness.resolver,
      assets: ASSETS,
      csp: true,
      passwordMinLength: 16,
    });
    const response = await custom.handle(request('/cms?next=/about'));
    const html = (await response?.text()) ?? '';
    expect(islandOf(html)).toMatchObject({ passwordMinLength: 16 });
  });

  it('sends an editor straight to the page in edit mode', async () => {
    const response = await page('/cms?next=/about', {
      cookie: harness.editor.cookie,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/about?_edit=1');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sends a signed-in user who cannot edit the same way: the shell decides what they see', async () => {
    const response = await page('/cms', { cookie: harness.viewer.cookie });
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/?_edit=1');
  });

  it('sends a role that has to set up two-step sign-in to the enrolment step', async () => {
    const response = await page('/cms?next=/about', {
      cookie: harness.superadmin.cookie,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(
      '/cms/two-factor/enrol?next=%2Fabout',
    );
  });

  it('answers a HEAD request like a GET', async () => {
    const response = await pages().handle(request('/cms', { method: 'HEAD' }));
    expect(response?.status).toBe(200);
  });

  it('is not the handler for other methods', async () => {
    expect(
      await pages().handle(request('/cms', { method: 'POST' })),
    ).toBeNull();
  });
});

describe('the password link landings', () => {
  it('shows the set-password step when a token is present, and keeps the token out of the page', async () => {
    const response = await page(`/cms/set-password?token=${TOKEN}`);
    expectLoginDocument(response);
    const html = await response.text();
    expect(html).toContain(`>${STRINGS['login.setPassword.heading']}</h1>`);
    expect(html).toContain(STRINGS['login.setPassword.submit']);
    expect(html).not.toContain(TOKEN);
    expect(islandOf(html)).toMatchObject({
      kind: 'login',
      step: 'set-password',
    });
    for (const [, value] of response.headers) {
      expect(value).not.toContain(TOKEN);
    }
  });

  it('shows the reset-password step when a token is present, and keeps the token out of the page', async () => {
    const response = await page(`/cms/reset-password?token=${TOKEN}`);
    expectLoginDocument(response);
    const html = await response.text();
    expect(html).toContain(`>${STRINGS['login.resetPassword.heading']}</h1>`);
    expect(html).not.toContain(TOKEN);
    expect(JSON.stringify(islandOf(html))).not.toContain(TOKEN);
  });

  it('keeps the token out of the page even when it is also the next value', async () => {
    const response = await page(
      `/cms/reset-password?token=${TOKEN}&next=${encodeURIComponent(`/about?x=${TOKEN}`)}`,
    );
    // `next` is the page the visitor was on; a token a caller chose to put
    // there is theirs. The token parameter itself is never read into markup.
    const html = await response.text();
    expect(html.split(TOKEN).length - 1).toBe(
      // the backdrop source, the Back to site link and the island
      3,
    );
  });

  it.each([
    ['set-password', 'invite', 'login.invalidLink.invite.body'],
    ['reset-password', 'reset', 'login.invalidLink.body'],
  ] as const)(
    'lands %s without a token on the invalid link step (%s)',
    async (path, linkKind, bodyKey) => {
      for (const query of ['', '?token=', `?token=${'x'.repeat(513)}`]) {
        const response = await page(`/cms/${path}${query}`);
        expectLoginDocument(response);
        const html = await response.text();
        expect(html).toContain(`>${STRINGS['login.invalidLink.heading']}</h1>`);
        expect(html).toContain(STRINGS[bodyKey]);
        expect(islandOf(html)).toMatchObject({
          step: 'invalid-link',
          linkKind,
        });
      }
    },
  );

  it('offers the right way forward per link kind', async () => {
    const reset = await (await page('/cms/reset-password')).text();
    expect(reset).toContain(STRINGS['login.invalidLink.reset.submit']);
    const invite = await (await page('/cms/set-password')).text();
    expect(invite).toContain(STRINGS['login.invalidLink.invite.submit']);
  });

  it('gives an expired, used or malformed link identical words', async () => {
    const empty = await (await page('/cms/reset-password?token=')).text();
    const missing = await (await page('/cms/reset-password')).text();
    const strip = (html: string): string => html.replace(/<script[^]*$/, '');
    expect(strip(empty)).toBe(strip(missing));
  });

  it('sanitises next on every landing', async () => {
    for (const hostile of ['//evil.test', 'https://evil.test', '/cms/logout']) {
      const response = await page(
        `/cms/reset-password?token=${TOKEN}&next=${encodeURIComponent(hostile)}`,
      );
      const html = await response.text();
      expect(backdropSrc(html)).toBe('/');
      expect(html).not.toContain('evil.test');
    }
    const kept = await (
      await page(`/cms/set-password?token=${TOKEN}&next=/about`)
    ).text();
    expect(backdropSrc(kept)).toBe('/about');
  });

  it('matches the path whatever its casing and with a trailing slash', async () => {
    const response = await page(`/CMS/Reset-Password/?token=${TOKEN}`);
    expectLoginDocument(response);
    expect(await response.text()).toContain(
      STRINGS['login.resetPassword.heading'],
    );
  });
});

describe('the sign-in link landing', () => {
  it('shows the signing-in status when a session exists', async () => {
    const response = await page('/cms/magic-link?next=/about', {
      cookie: harness.editor.cookie,
    });
    expectLoginDocument(response);
    const html = await response.text();
    expect(html).toContain(
      `>${STRINGS['login.magicLinkLanding.heading']}</h1>`,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain(STRINGS['login.magicLinkLanding.status']);
    expect(islandOf(html)).toMatchObject({
      step: 'magic-landing',
      next: '/about',
    });
  });

  it('shows the invalid link step without a session', async () => {
    const html = await (await page('/cms/magic-link')).text();
    expect(html).toContain(STRINGS['login.invalidLink.heading']);
    expect(html).toContain(STRINGS['login.invalidLink.signIn.submit']);
    expect(islandOf(html)).toMatchObject({
      step: 'invalid-link',
      linkKind: 'sign-in',
    });
  });

  it('tells a link that could not make a session apart, without saying why it could not', async () => {
    const html = await (
      await page('/cms/magic-link?error=failed_to_create_session&next=/about')
    ).text();
    expect(html).toContain(STRINGS['login.invalidLink.twoFactor.heading']);
    expect(html).toContain(STRINGS['login.invalidLink.twoFactor.body']);
    expect(html).not.toContain(STRINGS['login.invalidLink.signIn.submit']);
    expect(islandOf(html)).toMatchObject({
      step: 'invalid-link',
      linkKind: 'two-factor',
      next: '/about',
    });
  });

  it('shows the invalid link step when the link failed, session or not', async () => {
    const html = await (
      await page('/cms/magic-link?error=INVALID_TOKEN', {
        cookie: harness.editor.cookie,
      })
    ).text();
    expect(islandOf(html)).toMatchObject({
      step: 'invalid-link',
      linkKind: 'sign-in',
    });
  });
});

describe('the two-step sign-in enrolment step', () => {
  it('sends someone without a session to sign in first, remembering the page', async () => {
    const response = await page('/cms/two-factor/enrol?next=/about');
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/cms?next=%2Fabout');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sends a role that does not need it on to edit mode', async () => {
    const response = await page('/cms/two-factor/enrol?next=/about', {
      cookie: harness.editor.cookie,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/about?_edit=1');
  });

  it('shows the confirm step to a role that has to enrol, with the account address for the client', async () => {
    const response = await page('/cms/two-factor/enrol?next=/about', {
      cookie: harness.superadmin.cookie,
    });
    expectLoginDocument(response);
    const html = await response.text();
    expect(html).toContain(`>${STRINGS['enrol.confirm.heading']}</h1>`);
    expect(html).toContain(STRINGS['enrol.confirm.submit']);
    expect(islandOf(html)).toMatchObject({
      step: 'enrol',
      next: '/about',
      email: 'owner@example.com',
    });
  });

  it('never redirects off site', async () => {
    const response = await page(
      `/cms/two-factor/enrol?next=${encodeURIComponent('//evil.test')}`,
      { cookie: harness.editor.cookie },
    );
    expect(response.headers.get('Location')).toBe('/?_edit=1');
    const anonymous = await page(
      `/cms/two-factor/enrol?next=${encodeURIComponent('https://evil.test')}`,
    );
    expect(anonymous.headers.get('Location')).toBe('/cms?next=%2F');
  });
});

describe('paths the handler does not own', () => {
  it.each(['/cms/anything', '/cms/two-factor', '/cms/set-password/extra'])(
    'answers null for %s',
    async (path) => {
      expect(await pages().handle(request(path))).toBeNull();
    },
  );
});
