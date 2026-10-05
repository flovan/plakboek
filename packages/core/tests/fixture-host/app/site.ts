import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderHeadHtml } from '@plakboek/render/server';
import type { DocumentInput } from '@plakboek/render';
import type { SiteContext } from '@plakboek/core';

function header(
  site: SiteContext,
  items: Awaited<ReturnType<SiteContext['getMenu']>>,
): string {
  return renderToStaticMarkup(
    createElement(
      'header',
      null,
      createElement('a', { href: '/' }, site.siteName),
      createElement(
        'nav',
        { 'aria-label': 'Main' },
        createElement(
          'ul',
          null,
          items.map((item) =>
            createElement(
              'li',
              { key: item.href },
              createElement(
                'a',
                {
                  href: item.href,
                  ...(item.current ? { 'aria-current': 'page' as const } : {}),
                },
                item.label,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

export async function renderDocument(
  input: DocumentInput,
  site: SiteContext,
): Promise<string> {
  const menu = await site.getMenu('main');
  return [
    '<!DOCTYPE html>',
    `<html lang="${input.head.lang}">`,
    `<head>${renderHeadHtml(input.head)}</head>`,
    `<body>${header(site, menu)}${input.body}</body>`,
    '</html>',
  ].join('');
}

export async function renderNotFound(
  _request: Request,
  site: SiteContext,
): Promise<string> {
  const menu = await site.getMenu('main');
  return [
    '<!DOCTYPE html>',
    `<html lang="${site.locale}">`,
    '<head><meta charset="utf-8"><title>Page not found</title></head>',
    `<body>${header(site, menu)}<main><h1>Page not found</h1></main></body>`,
    '</html>',
  ].join('');
}
