import { renderHeadHtml } from '@plakboek/render/server';
import type { DocumentInput } from '@plakboek/render';

export function renderDocument(input: DocumentInput): string {
  return [
    '<!DOCTYPE html>',
    `<html lang="${input.head.lang}">`,
    `<head>${renderHeadHtml(input.head)}</head>`,
    `<body>${input.body}</body>`,
    '</html>',
  ].join('');
}
