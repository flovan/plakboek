import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderHeadHtml } from '@plakboek/render/server';
import type { DocumentInput } from '@plakboek/render';
import type { SiteContext } from '@plakboek/core';

/** The page served without any hostile stylesheet, for isolation baselines. */
const CLEAN_PATH = '/clean';

/** A page whose edit render fails, for the shell's failure panel. */
const BROKEN_PATH = '/broken';

function escapeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function header(site: SiteContext): string {
  return renderToStaticMarkup(
    createElement(
      'header',
      { className: 'site-header' },
      createElement('a', { href: '/', className: 'site-name' }, site.siteName),
      createElement('a', { href: '/about' }, 'About'),
      // A link whose own script handles the click and prevents its default.
      createElement(
        'a',
        { href: '/about', id: 'handled-link' },
        'Handled link',
      ),
      createElement(
        'a',
        { href: 'https://example.invalid/elsewhere', id: 'external-link' },
        'Elsewhere',
      ),
      createElement('a', { href: '#site-footer', id: 'hash-link' }, 'Footer'),
      createElement(
        'button',
        { type: 'button', id: 'open-site-dialog' },
        'Open dialog',
      ),
    ),
  );
}

function cleanDocument(input: DocumentInput, site: SiteContext): string {
  return [
    '<!DOCTYPE html>',
    `<html lang="${escapeText(input.head.lang)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    renderHeadHtml(input.head),
    '<link rel="stylesheet" href="/clean.css">',
    '</head>',
    `<body>${header(site)}<main>${input.body}</main></body>`,
    '</html>',
  ].join('');
}

/**
 * The adversarial site document: hostile CSS, site scripts, a sticky header,
 * a fixed bottom banner and a site-owned dialog around the page body.
 */
export function renderDocument(
  input: DocumentInput,
  site: SiteContext,
): string {
  if (input.publicPath === CLEAN_PATH) return cleanDocument(input, site);
  if (input.publicPath === BROKEN_PATH && input.mode === 'edit') {
    throw new Error('The e2e host cannot render this page for editing');
  }
  return [
    '<!DOCTYPE html>',
    `<html lang="${escapeText(input.head.lang)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    renderHeadHtml(input.head),
    '<link rel="stylesheet" href="/theme.css">',
    '<script src="/site.js" defer></script>',
    // Analytics must not count an editing session: omitted in the edit render.
    ...(input.mode === 'visitor'
      ? ['<script src="/analytics.js" defer></script>']
      : []),
    '</head>',
    '<body>',
    header(site),
    `<main class="reset-zone">${input.body}</main>`,
    '<footer id="site-footer">Site footer</footer>',
    '<div class="cookie-banner" role="region" aria-label="Cookies">We use cookies</div>',
    '<dialog id="site-dialog">',
    '<p>Site dialog</p>',
    '<button type="button" id="close-site-dialog">Close dialog</button>',
    '</dialog>',
    '</body>',
    '</html>',
  ].join('');
}

export function renderNotFound(_request: Request, site: SiteContext): string {
  return [
    '<!DOCTYPE html>',
    `<html lang="${escapeText(site.locale)}">`,
    '<head><meta charset="utf-8"><title>Page not found</title>',
    '<link rel="stylesheet" href="/clean.css"></head>',
    `<body>${header(site)}<main><h1>Page not found</h1></main></body>`,
    '</html>',
  ].join('');
}
