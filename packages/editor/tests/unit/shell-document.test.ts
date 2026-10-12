import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ShellApp } from '../../src/chrome/shell.js';
import type { ShellIsland } from '../../src/chrome/island.js';
import { ISLAND_ELEMENT_ID as ISLAND_ID } from '../../src/chrome/island.js';
import { STRINGS } from '../../src/chrome/strings.js';
import { CHROME_STYLE_CSP_HASH } from '../../src/chrome/styles.js';
import { renderEditorScripts } from '../../src/server/assets.js';
import { cspHashOf } from '../../src/server/html-document.js';
import {
  LAYOUT_SCRIPT,
  LAYOUT_SCRIPT_CSP_HASH,
} from '../../src/server/layout-script.js';
import {
  renderShellDocument,
  SHELL_HEAD_STYLE,
  SHELL_HEAD_STYLE_CSP_HASH,
} from '../../src/server/shell-document.js';

const ASSETS = {
  entry: '/assets/editor-abc.js',
  preload: ['/assets/chunk-1.js'],
  css: ['/assets/editor-abc.css'],
};

function shell(
  overrides: {
    name?: string;
    email?: string;
    canEdit?: boolean;
    visitorLocation?: string;
    csp?: boolean;
  } = {},
) {
  return renderShellDocument({
    identity: {
      name: overrides.name ?? 'Ada Lovelace',
      email: overrides.email ?? 'ada@example.com',
      canEdit: overrides.canEdit ?? true,
    },
    visitorLocation: overrides.visitorLocation ?? '/about',
    assets: ASSETS,
    csp: overrides.csp ?? true,
  });
}

/** The markup inside the declarative shadow root. */
function templateOf(html: string): string {
  const start = html.indexOf('<template shadowrootmode="open">');
  const end = html.indexOf('</template>');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, end);
}

const ISLAND: ShellIsland = {
  kind: 'shell',
  mode: 'edit',
  user: { name: 'Ada', email: 'ada@example.com' },
  visitorLocation: '/about',
  frameUrl: '/about?_edit=frame',
  logoutPath: '/cms/logout',
};

function staticShell(
  island: ShellIsland,
  options: {
    hydrated?: boolean;
    nav?: (context: { layout: 'framed' | 'full' }) => string;
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(ShellApp, {
      island,
      hydrated: options.hydrated ?? false,
      slots: options.nav === undefined ? undefined : { nav: options.nav },
    }),
  );
}

describe('the shell document', () => {
  it('is a complete noindex document whose only host element carries a declarative shadow root', () => {
    const { html } = shell();
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('<title>Plakboek</title>');
    expect(html).toContain(
      '<plakboek-editor data-layout="framed" data-mode="edit"><template shadowrootmode="open">',
    );
    expect(html.match(/<plakboek-editor/g)).toHaveLength(1);
  });

  it('puts the chrome stylesheet, the shell root, the sidebar and the stage inside the shadow root', () => {
    const template = templateOf(shell().html);
    expect(template).toContain('<style>');
    expect(template).toContain('id="plakboek-shell-root"');
    expect(template).toContain(
      `<aside aria-label="${STRINGS['landmark.sidebar']}"`,
    );
    expect(template).toContain('id="plakboek-stage"');
  });

  it('frames the page at its frame URL, keeping its query', () => {
    const { html } = shell({ visitorLocation: '/about?utm=x' });
    expect(html).toContain('<iframe');
    expect(html).toContain('src="/about?utm=x&amp;_edit=frame"');
    expect(html).toContain(`title="${STRINGS['landmark.frame']}"`);
  });

  it('carries no style attribute inside the shadow root', () => {
    expect(
      templateOf(shell().html).replace(/<style>[\s\S]*?<\/style>/, ''),
    ).not.toMatch(/\sstyle=/);
  });

  it('holds the island after the host and the script tags after the island', () => {
    const { html } = shell();
    const host = html.indexOf('</plakboek-editor>');
    const island = html.indexOf(
      `<script type="application/json" id="${ISLAND_ID}">`,
    );
    const entry = html.indexOf(
      '<script type="module" src="/assets/editor-abc.js">',
    );
    expect(host).toBeGreaterThan(-1);
    expect(island).toBeGreaterThan(host);
    expect(entry).toBeGreaterThan(island);
  });

  it('writes an island with only what the chrome needs', () => {
    const { html } = shell({ visitorLocation: '/about?utm=x' });
    const match = new RegExp(
      `<script type="application/json" id="${ISLAND_ID}">([\\s\\S]*?)</script>`,
    ).exec(html);
    expect(match).not.toBeNull();
    expect(JSON.parse(match?.[1] ?? '')).toEqual({
      kind: 'shell',
      mode: 'edit',
      user: { name: 'Ada Lovelace', email: 'ada@example.com' },
      visitorLocation: '/about?utm=x',
      frameUrl: '/about?utm=x&_edit=frame',
      logoutPath: '/cms/logout',
    });
  });

  it('cannot be broken out of by a hostile display name, in the island or the markup', () => {
    const hostile = '</script><img src=x onerror=alert(1)> ';
    const { html } = shell({ name: hostile });
    const island = new RegExp(
      `<script type="application/json" id="${ISLAND_ID}">([\\s\\S]*?)</script>`,
    ).exec(html)?.[1];
    expect(island).not.toContain('<');
    expect(JSON.parse(island ?? '').user.name).toBe(hostile);
    expect(html).not.toContain('<img src=x');
    // the layout script, the island and the entry module are the only scripts
    expect(html.match(/<script/g)).toHaveLength(3);
  });

  it('is the read-only variant for a user who cannot edit', () => {
    const { html } = shell({ canEdit: false });
    expect(html).toContain('data-mode="read-only"');
    expect(html).toContain(STRINGS['sidebar.readOnly']);
  });

  it('marks the edit variant without the read-only notice', () => {
    expect(shell().html).not.toContain(STRINGS['sidebar.readOnly']);
  });

  it('sends the shell headers, with a policy that allows exactly the two inline styles', () => {
    const { headers } = shell();
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['X-Robots-Tag']).toBe('noindex, nofollow');
    const policy = headers['Content-Security-Policy'] ?? '';
    expect(policy).toContain(`'${CHROME_STYLE_CSP_HASH}'`);
    expect(policy).toContain(`'${SHELL_HEAD_STYLE_CSP_HASH}'`);
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it('allows the head style by the hash of its exact text', () => {
    expect(SHELL_HEAD_STYLE_CSP_HASH).toBe(cspHashOf(SHELL_HEAD_STYLE));
    expect(shell().html).toContain(`<style>${SHELL_HEAD_STYLE}</style>`);
  });

  it('puts the layout script right after the host element, before the island and the editor entry', () => {
    const { html } = shell();
    const host = html.indexOf('</plakboek-editor>');
    const layout = html.indexOf(`<script>${LAYOUT_SCRIPT}</script>`);
    const island = html.indexOf(
      `<script type="application/json" id="${ISLAND_ID}">`,
    );
    expect(layout).toBe(host + '</plakboek-editor>'.length);
    expect(layout).toBeLessThan(island);
  });

  it('allows the layout script by the hash of its exact text, and no other inline script', () => {
    const { html, headers } = shell();
    const policy = headers['Content-Security-Policy'] ?? '';
    const scriptSources = /script-src ([^;]*)/.exec(policy)?.[1] ?? '';
    expect(scriptSources).toBe(`'self' '${LAYOUT_SCRIPT_CSP_HASH}'`);
    expect(LAYOUT_SCRIPT_CSP_HASH).toBe(cspHashOf(LAYOUT_SCRIPT));
    // every other script tag is the JSON island (data, never executed) or a
    // module loaded by URL
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)].map(
      (match) => match[0],
    );
    expect(inline).toEqual([
      '<script>',
      `<script type="application/json" id="${ISLAND_ID}">`,
    ]);
  });

  it('sends no policy when switched off', () => {
    expect(
      shell({ csp: false }).headers['Content-Security-Policy'],
    ).toBeUndefined();
  });

  it('sends no policy while development scripts are present, because inline code has no stable hash', () => {
    const { headers } = renderShellDocument({
      identity: { name: 'A', email: 'a@example.com', canEdit: true },
      visitorLocation: '/',
      assets: { ...ASSETS, devScripts: [{ code: 'window.refresh = 1' }] },
      csp: true,
    });
    expect(headers['Content-Security-Policy']).toBeUndefined();
  });
});

describe('the editor script tags', () => {
  it('lists preloads, stylesheets, development scripts in order, then the entry', () => {
    const tags = renderEditorScripts({
      entry: '/e.js',
      preload: ['/p.js'],
      css: ['/s.css'],
      devScripts: [{ src: '/@vite/client' }, { code: 'a()' }],
    });
    expect(tags).toBe(
      '<link rel="modulepreload" href="/p.js">' +
        '<link rel="stylesheet" href="/s.css">' +
        '<script type="module" src="/@vite/client"></script>' +
        '<script type="module">a()</script>' +
        '<script type="module" src="/e.js"></script>',
    );
  });

  it('escapes every URL and cannot be closed by inline development code', () => {
    const tags = renderEditorScripts({
      entry: '/e.js?"><script>x</script>',
      preload: [],
      css: [],
      devScripts: [{ code: 'a</script><b>' }],
    });
    expect(tags).not.toContain('"><script>');
    expect(tags).toContain('a<\\/script><b>');
  });
});

describe('the sidebar', () => {
  it('lists skip link, product name, nav slot, full-width toggle, exit, user name and log out in order', () => {
    const html = staticShell(ISLAND);
    const order = [
      STRINGS['sidebar.skipLink'],
      STRINGS['product.name'],
      'data-slot="nav"',
      STRINGS['sidebar.fullWidth'],
      STRINGS['sidebar.exit'],
      'Ada',
      STRINGS['sidebar.logOut'],
    ].map((needle) => html.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('shows the read-only notice, as a note, only in read-only mode', () => {
    expect(staticShell(ISLAND)).not.toContain('role="note"');
    const readOnly = staticShell({ ...ISLAND, mode: 'read-only' });
    expect(readOnly).toContain('role="note"');
    expect(readOnly).toContain(STRINGS['sidebar.readOnly']);
    const noteAt = readOnly.indexOf('role="note"');
    expect(noteAt).toBeGreaterThan(readOnly.indexOf(STRINGS['product.name']));
    expect(noteAt).toBeLessThan(readOnly.indexOf('data-slot="nav"'));
  });

  it('renders nothing in the nav slot by default, and the slot output when given', () => {
    expect(staticShell(ISLAND)).toMatch(/data-slot="nav"[^>]*><\/div>/);
    const html = staticShell(ISLAND, {
      nav: (context) => `<nav-${context.layout}>`,
    });
    expect(html).toContain('&lt;nav-framed&gt;');
    expect(html).toContain('&lt;nav-full&gt;');
  });

  it('disables the full-width toggle until hydration', () => {
    const before = staticShell(ISLAND, { hydrated: false });
    const after = staticShell(ISLAND, { hydrated: true });
    expect(before).toContain('aria-pressed="false" disabled=""');
    expect(after).not.toContain('disabled=""');
  });

  it('exits through a real anchor to the visitor location', () => {
    expect(staticShell(ISLAND)).toMatch(
      new RegExp(
        `<a href="/about"[^>]*>(?:<svg[\\s\\S]*?</svg>)?${STRINGS['sidebar.exit']}`,
      ),
    );
  });

  it('logs out through a real post form that carries the visitor location', () => {
    const html = staticShell({ ...ISLAND, visitorLocation: '/about?utm=x' });
    const form = /<form [^>]*>/.exec(html)?.[0] ?? '';
    expect(form).toContain('method="post"');
    expect(form).toContain('action="/cms/logout"');
    expect(html).toContain(
      '<input type="hidden" name="next" value="/about?utm=x"/>',
    );
    expect(html).toContain('type="submit"');
  });

  it('shows the email when the name is empty', () => {
    const html = staticShell({
      ...ISLAND,
      user: { name: '  ', email: 'ada@example.com' },
    });
    expect(html).toContain('>ada@example.com</p>');
  });

  it('clamps a long user name without clipping the rest of the sidebar', () => {
    const html = staticShell(ISLAND);
    expect(html).toContain('line-clamp-2');
    expect(html).toContain('wrap-anywhere');
  });

  it('has no inline style attribute anywhere', () => {
    expect(staticShell({ ...ISLAND, mode: 'read-only' })).not.toMatch(
      /\sstyle=/,
    );
  });
});

describe('the rail', () => {
  /** The markup of the rail layer only. */
  function railOf(island: ShellIsland): string {
    const html = staticShell(island);
    const start = html.indexOf('data-rail=""');
    expect(start).toBeGreaterThan(-1);
    return html.slice(start);
  }

  it('is always in the markup beside the sidebar, so either layout paints without a script', () => {
    const html = staticShell(ISLAND);
    expect(html.match(/<aside/g)).toHaveLength(1);
    expect(html).toContain('data-sidebar=""');
    expect(html).toContain('data-rail=""');
  });

  it('lists skip link, product name, nav slot, then the toggle, exit, avatar and log out', () => {
    const rail = railOf(ISLAND);
    const order = [
      STRINGS['sidebar.skipLink'],
      `>${STRINGS['product.name']}<`,
      'data-slot="nav"',
      `aria-label="${STRINGS['sidebar.fullWidth']}"`,
      `aria-label="${STRINGS['sidebar.exit']}"`,
      'role="img"',
      `aria-label="${STRINGS['sidebar.logOut']}"`,
    ].map((needle) => rail.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('names every icon button by its expanded label and gives it a tooltip with the same text', () => {
    const rail = railOf(ISLAND);
    for (const key of [
      'sidebar.fullWidth',
      'sidebar.exit',
      'sidebar.logOut',
    ] as const) {
      expect(rail).toContain(`aria-label="${STRINGS[key]}"`);
      expect(rail).toMatch(
        new RegExp(`data-tooltip=""[^>]*>${STRINGS[key]}</span>`),
      );
    }
  });

  it('shows the first letter of the name as the avatar, named and tooltipped with the whole name', () => {
    const rail = railOf({
      ...ISLAND,
      user: { name: 'ada Lovelace', email: 'ada@example.com' },
    });
    expect(rail).toMatch(
      /<div role="img" aria-label="ada Lovelace"[^>]*>A<\/div>/,
    );
    expect(rail).toMatch(/data-tooltip=""[^>]*>ada Lovelace<\/span>/);
  });

  it('falls back to the email for the avatar letter and its name', () => {
    const rail = railOf({
      ...ISLAND,
      user: { name: ' ', email: 'zed@example.com' },
    });
    expect(rail).toContain('aria-label="zed@example.com"');
    expect(rail).toMatch(/>Z<\/div>/);
  });

  it('keeps exit a real anchor and log out a real post form', () => {
    const rail = railOf({ ...ISLAND, visitorLocation: '/about?utm=x' });
    expect(rail).toContain('<a href="/about?utm=x"');
    expect(rail).toMatch(/<form [^>]*action="\/cms\/logout"[^>]*method="post"/);
    expect(rail).toContain(
      '<input type="hidden" name="next" value="/about?utm=x"/>',
    );
  });

  it('disables the toggle until hydration and presses it when full', () => {
    const before = railOf(ISLAND);
    expect(before).toMatch(/aria-pressed="false" disabled=""/);
    const html = renderToStaticMarkup(
      createElement(ShellApp, {
        island: ISLAND,
        hydrated: true,
        layout: 'full',
      }),
    );
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(html).not.toContain('disabled=""');
  });

  it('is hidden by default and shown only by the host layout, so the framed paint cannot flash it', () => {
    expect(staticShell(ISLAND)).toMatch(
      /class="invisible absolute [^"]*" data-rail=""/,
    );
    const sidebar = staticShell(ISLAND);
    const framedClass = /class="([^"]*)" data-sidebar=""/.exec(sidebar)?.[1];
    // `&` is written as an entity in the markup and read back as `&`
    expect(framedClass).toContain(
      '[:host([data-layout=full])_&amp;]:invisible',
    );
  });

  // The e2e focus test in packages/core depends on this split: a hidden-to-
  // visible transition is still hidden at its start, so the shown toggle could
  // not take focus.
  it('leaves visibility out of the transition of the layer being shown, so its toggle can take focus at once', () => {
    const html = staticShell(ISLAND);
    const railClass = /class="([^"]*)" data-rail=""/.exec(html)?.[1];
    const sidebarClass = /class="([^"]*)" data-sidebar=""/.exec(html)?.[1];
    if (railClass === undefined || sidebarClass === undefined) {
      throw new Error('The shell markup has no rail or sidebar layer');
    }
    const rail = railClass.split(' ');
    const sidebar = sidebarClass.split(' ');

    expect(rail).toContain(
      'motion-safe:transition-[opacity,translate,visibility]',
    );
    expect(rail).toContain(
      'motion-safe:[:host([data-layout=full])_&amp;]:transition-[opacity,translate]',
    );
    expect(sidebar).toContain('motion-safe:transition-[opacity,translate]');
    expect(sidebar).toContain(
      'motion-safe:[:host([data-layout=full])_&amp;]:transition-[opacity,translate,visibility]',
    );
  });
});

describe('the frame area', () => {
  it('always carries the narrow-window panel, hidden until the window is under 1024px, and hides the frame there', () => {
    const html = staticShell(ISLAND);
    expect(html).toContain(STRINGS['frame.narrow.heading']);
    expect(html).toContain(STRINGS['frame.narrow.body']);
    expect(html).toMatch(/class="hidden h-full max-\[1024px\]:block"/);
    expect(html).toMatch(/<iframe class="pk-frame max-\[1024px\]:hidden"/);
  });

  it('has no failure panel while the frame is fine', () => {
    const html = staticShell(ISLAND);
    expect(html).not.toContain(STRINGS['frame.error.heading']);
    expect(html).not.toContain('role="alert"');
  });

  it('draws the failure panel, with a reload button and nothing of the failure, in the hidden frame’s place', () => {
    const html = renderToStaticMarkup(
      createElement(ShellApp, {
        island: ISLAND,
        hydrated: true,
        frameFailed: true,
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain(STRINGS['frame.error.heading']);
    expect(html).toContain(STRINGS['frame.error.body']);
    expect(html).toMatch(
      new RegExp(`<button[^>]*>${STRINGS['frame.error.reload']}</button>`),
    );
    // the iframe stays in the tree (hiding it does not reload it)
    expect(html).toMatch(
      /<iframe class="pk-frame hidden" src="\/about\?_edit=frame"/,
    );
  });

  it('gives the narrow-window panel no button', () => {
    const html = staticShell(ISLAND);
    const panel = html.slice(html.indexOf('role="status"'));
    expect(panel).not.toContain('<button');
  });
});
