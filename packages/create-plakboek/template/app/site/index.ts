import type { SiteContext } from '@plakboek/core';
import type { DocumentInput } from '@plakboek/render';
import { renderHeadHtml } from '@plakboek/render/server';

// The document around every CMS page. Visitors get plain HTML: no script tag
// is written here, so pages ship without client JavaScript.
export function renderDocument(
  input: DocumentInput,
  _site: SiteContext,
): string {
  return [
    '<!DOCTYPE html>',
    `<html lang="${input.head.lang}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    renderHeadHtml(input.head),
    '</head>',
    `<body>${input.body}</body>`,
    '</html>',
  ].join('');
}
