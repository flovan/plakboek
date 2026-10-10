import { describe, expect, it } from 'vitest';
import {
  ISLAND_ELEMENT_ID,
  LOGIN_ROOT_ID,
  type LoginIsland,
} from '../../src/chrome/island.js';
import { STRINGS } from '../../src/chrome/strings.js';
import { CHROME_STYLE_CSP_HASH } from '../../src/chrome/styles.js';
import { renderLoginDocument } from '../../src/server/login-document.js';
import { SHELL_HEAD_STYLE_CSP_HASH } from '../../src/server/shell-document.js';

const ASSETS = {
  entry: '/assets/editor-abc.js',
  preload: ['/assets/chunk-1.js'],
  css: [],
};

function island(overrides: Partial<LoginIsland> = {}): LoginIsland {
  return {
    kind: 'login',
    step: 'sign-in',
    next: '/about',
    twoFactorRequiredRoles: ['superadmin'],
    ...overrides,
  };
}

function login(
  overrides: Partial<LoginIsland> = {},
  options: { csp?: boolean } = {},
) {
  return renderLoginDocument({
    island: island(overrides),
    assets: ASSETS,
    csp: options.csp ?? true,
  });
}

/** The markup inside the declarative shadow root. */
function templateOf(html: string): string {
  const start = html.indexOf('<template shadowrootmode="open">');
  const end = html.indexOf('</template>');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, end);
}

/** The attributes of the first tag matching `pattern` in `markup`. */
function tagOf(markup: string, pattern: RegExp): string {
  const found = pattern.exec(markup);
  expect(found).not.toBeNull();
  return found?.[0] ?? '';
}

describe('renderLoginDocument', () => {
  it('is a complete editor-owned document that says noindex and is titled for sign-in', () => {
    const { html } = login();
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('<title>Sign in · Plakboek</title>');
  });

  it('paints from a declarative shadow root: the stylesheet, the backdrop and an open dialog', () => {
    const { html } = login();
    const template = templateOf(html);
    expect(html).toContain('<plakboek-editor data-mode="login">');
    expect(template).toContain('<style>');
    expect(template.indexOf('<style>')).toBeLessThan(
      template.indexOf('<iframe'),
    );
    expect(template).toContain(`<div id="${LOGIN_ROOT_ID}">`);
    expect(template).toMatch(/<dialog[^>]* open(?:="")?[ >]/);
    expect(template).toContain('aria-labelledby="plakboek-login-heading"');
    expect(template).toContain('aria-modal="true"');
  });

  it('shows the page behind the card in a blurred, inert iframe kept out of assistive technology', () => {
    const { html } = login({ next: '/about?x=1&y=2' });
    const frame = tagOf(templateOf(html), /<iframe[^>]*>/);
    expect(frame).toContain('class="pk-backdrop"');
    expect(frame).toContain('src="/about?x=1&amp;y=2"');
    expect(frame).toContain('tabindex="-1"');
    expect(frame).toContain('aria-hidden="true"');
    expect(frame).toMatch(/ inert(?:="")?[ >]/);
    expect(frame).not.toContain('style=');
  });

  it('keeps the backdrop outside the hydrated root, so hydrating the card cannot reload it', () => {
    const template = templateOf(login().html);
    const rootStart = template.indexOf(`<div id="${LOGIN_ROOT_ID}">`);
    expect(template.indexOf('<iframe')).toBeLessThan(rootStart);
    expect(template.slice(rootStart)).not.toContain('<iframe');
  });

  it('attribute-escapes a hostile next in the iframe source', () => {
    const { html } = login({ next: '/a"><script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)');
    expect(templateOf(html)).toContain('src="/a&quot;&gt;&lt;script&gt;');
  });

  it('renders the sign-in step with its fields, autocomplete values and autofocus', () => {
    const template = templateOf(login().html);
    const email = tagOf(template, /<input[^>]*name="email"[^>]*>/);
    expect(email).toContain('type="email"');
    expect(email).toMatch(/autocomplete="username"/i);
    expect(email).toContain('autofocus');
    const password = tagOf(template, /<input[^>]*name="password"[^>]*>/);
    expect(password).toContain('type="password"');
    expect(password).toMatch(/autocomplete="current-password"/i);
    expect(template).toContain('<h1');
    expect(template).toContain(`>${STRINGS['login.signIn.heading']}</h1>`);
    expect(template).toContain(STRINGS['login.signIn.forgot']);
    expect(template).toContain(STRINGS['login.signIn.submit']);
    expect(template).toContain(STRINGS['login.signIn.magicLink']);
  });

  it('labels both fields', () => {
    const template = templateOf(login().html);
    expect(template).toMatch(
      /<label[^>]*for="plakboek-login-email"[^>]*>Email address<\/label>/,
    );
    expect(template).toMatch(
      /<label[^>]*for="plakboek-login-password"[^>]*>Password<\/label>/,
    );
  });

  it('posts the form to /cms, which refuses it, so a password never reaches an address', () => {
    const form = tagOf(templateOf(login().html), /<form[^>]*>/);
    expect(form).toContain('method="post"');
    expect(form).toContain('action="/cms"');
  });

  it('leads Back to site to the same page the backdrop shows', () => {
    const template = templateOf(login({ next: '/about?x=1' }).html);
    expect(template).toMatch(/<a href="\/about\?x=1"[^>]*>Back to site<\/a>/);
  });

  it('puts no style attribute anywhere in the card markup', () => {
    const template = templateOf(login().html);
    const afterStyleSheet = template.slice(template.indexOf('</style>'));
    expect(afterStyleSheet).not.toContain(' style=');
  });

  it('writes the island as escaped JSON that parses back to the same value', () => {
    const value = island({ next: '/a?q=</script><b>&c', email: 'a@b.test' });
    const { html } = renderLoginDocument({
      island: value,
      assets: ASSETS,
      csp: true,
    });
    const match = new RegExp(
      `<script type="application/json" id="${ISLAND_ELEMENT_ID}">([^]*?)</script>`,
    ).exec(html);
    expect(match).not.toBeNull();
    const body = match?.[1] ?? '';
    expect(body).not.toContain('<');
    expect(JSON.parse(body)).toEqual(value);
  });

  it('loads the editor client after the card', () => {
    const { html } = login();
    expect(html).toContain(
      '<link rel="modulepreload" href="/assets/chunk-1.js">',
    );
    expect(html.lastIndexOf('/assets/editor-abc.js')).toBeGreaterThan(
      html.indexOf(LOGIN_ROOT_ID),
    );
  });

  describe('headers', () => {
    it('is never framed, never indexed and sends no referrer', () => {
      const { headers } = login();
      expect(headers['X-Frame-Options']).toBe('DENY');
      expect(headers['X-Robots-Tag']).toBe('noindex, nofollow');
      expect(headers['Referrer-Policy']).toBe('no-referrer');
      expect(headers['X-Content-Type-Options']).toBe('nosniff');
      expect(headers['Content-Type']).toBe('text/html; charset=utf-8');
    });

    it('sends a policy that allows only the chrome style and the head style by hash, and frames only this origin', () => {
      const policy = login().headers['Content-Security-Policy'] ?? '';
      expect(policy).toContain(`'${CHROME_STYLE_CSP_HASH}'`);
      expect(policy).toContain(`'${SHELL_HEAD_STYLE_CSP_HASH}'`);
      expect(policy).toContain("frame-src 'self'");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).not.toContain('unsafe-inline');
    });

    it('sends no policy when asked not to, and none with development scripts', () => {
      expect(
        login({}, { csp: false }).headers['Content-Security-Policy'],
      ).toBeUndefined();
      const dev = renderLoginDocument({
        island: island(),
        assets: { ...ASSETS, devScripts: [{ code: 'window.x = 1' }] },
        csp: true,
      });
      expect(dev.headers['Content-Security-Policy']).toBeUndefined();
    });
  });
});
