import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  createTextEnvironment,
  TextEnvironmentProvider,
  type BlockComponent,
} from '@plakboek/render';
import { createLiveEdit } from '@plakboek/render/server';

// The starter blocks only need defineBlock to hand their definition back, so
// the test renders the shipped files without pulling in the whole core.
vi.mock('@plakboek/core', () => ({
  defineBlock: <T>(definition: T): T => definition,
}));

const { heading } = await import('../../template/blocks/heading.js');
const { section } = await import('../../template/blocks/section.js');
const { text } = await import('../../template/blocks/text.js');
const { button } = await import('../../template/blocks/button.js');
const { default: textTheme } = await import('../../template/text-theme.js');

// What the host's render path provides: the starter's own text theme.
const environment = createTextEnvironment({ definition: textTheme });

type Definition = { component: BlockComponent<Record<string, unknown>> };

function renderLive(
  definition: unknown,
  input: { id: string; blockType: string; kind: 'block' | 'section' },
  props: Record<string, unknown>,
): string {
  const { component } = definition as Definition;
  const edit = createLiveEdit({ ...input, label: input.blockType });
  return renderToStaticMarkup(
    createElement(
      TextEnvironmentProvider,
      { environment },
      component({
        block: { id: input.id, blockType: input.blockType, schemaVersion: 1 },
        props,
        edit,
        children: null,
        layout: {},
      }) as ReactElement,
    ),
  );
}

describe('the starter blocks in a live render', () => {
  it.each(['2', '3', '4'])(
    'puts the identity of a level %s heading and its text on the heading element',
    (level) => {
      const markup = renderLive(
        heading,
        { id: 'heading-1', blockType: 'heading', kind: 'block' },
        { text: 'Welcome', level },
      );
      expect(markup).toMatch(
        new RegExp(`^<h${level}[^>]*data-pk-block="heading-1"`),
      );
      expect(markup).toMatch(
        new RegExp(`^<h${level}[^>]*data-pk-field="text"`),
      );
    },
  );

  it('puts the identity and the body field of a text block on its root and renders the stored paragraphs', () => {
    const markup = renderLive(
      text,
      { id: 'text-1', blockType: 'text', kind: 'block' },
      {
        body: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
          ],
        },
      },
    );
    expect(markup).toMatch(/^<div[^>]*data-pk-block="text-1"/);
    expect(markup).toMatch(/^<div[^>]*data-pk-field="body"/);
    expect(markup).toContain('<p class="text-base text-text">Hello</p>');
  });

  it('puts the identity and the link field of a button block on its root and renders the themed button', () => {
    const markup = renderLive(
      button,
      { id: 'button-1', blockType: 'button', kind: 'block' },
      {
        label: 'Contact',
        link: { href: '/contact', pageId: null, target: '_blank' },
        variant: 'secondary',
      },
    );
    expect(markup).toMatch(/^<div[^>]*data-pk-block="button-1"/);
    expect(markup).toMatch(/^<div[^>]*data-pk-field="link"/);
    expect(markup).toContain('href="/contact"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain('border-text');
  });

  it('puts the identity of a section on its root element', () => {
    const markup = renderLive(
      section,
      { id: 'section-1', blockType: 'section', kind: 'section' },
      {},
    );
    expect(markup).toMatch(/^<section[^>]*data-pk-block="section-1"/);
  });
});
