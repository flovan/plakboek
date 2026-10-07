import type { SiteContext } from '@plakboek/core';
import type { DocumentInput, PageHead } from '@plakboek/render';
import { renderHeadHtml } from '@plakboek/render/server';
import { renderToStaticMarkup } from 'react-dom/server';
import appCss from '../app.css?url';
import { Footer } from './footer.tsx';
import { Header } from './header.tsx';

// In development the plain `?url` address serves JavaScript, so the dev
// server is asked for the stylesheet itself with its direct-request suffix.
const stylesheetHref = import.meta.env.DEV ? `${appCss}?direct` : appCss;

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// First focusable element on the page, hidden until it receives focus.
const skipLink = renderToStaticMarkup(
  <a
    href="#content"
    className="sr-only focus:not-sr-only focus:fixed focus:top-0 focus:left-0 focus:z-10 focus:bg-surface focus:p-4 focus:text-text focus:outline-2 focus:outline-accent"
  >
    Skip to content
  </a>,
);

export type PageInput = {
  readonly head: PageHead;
  /** The page's content as HTML that is already rendered and escaped. */
  readonly main: string;
  readonly site: SiteContext;
};

// The shared document: skip link, header, main, footer. The 404 and 500
// pages use it too, so a change here shows on every page of the site.
// Visitor pages carry no script of their own.
export async function renderPage({
  head,
  main,
  site,
}: PageInput): Promise<string> {
  const items = await site.getMenu('main');
  const header = renderToStaticMarkup(
    <Header siteName={site.siteName} items={items} />,
  );
  const footer = renderToStaticMarkup(
    <Footer
      siteName={site.siteName}
      items={items}
      year={new Date().getFullYear()}
    />,
  );
  return [
    '<!DOCTYPE html>',
    `<html lang="${escapeAttribute(head.lang)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light">',
    renderHeadHtml(head),
    `<link rel="stylesheet" href="${escapeAttribute(stylesheetHref)}">`,
    '</head>',
    '<body class="flex min-h-screen flex-col bg-surface font-sans text-text">',
    `${skipLink}${header}<main id="content" class="flex-1">${main}</main>${footer}`,
    '</body>',
    '</html>',
  ].join('');
}

export async function renderDocument(
  input: DocumentInput,
  site: SiteContext,
): Promise<string> {
  return await renderPage({ head: input.head, main: input.body, site });
}
