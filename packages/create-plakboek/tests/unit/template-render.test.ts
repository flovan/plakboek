import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BlockComponent } from '@plakboek/render';
import { createLiveEdit } from '@plakboek/render/server';

// The starter blocks only need defineBlock to hand their definition back, so
// the test renders the shipped files without pulling in the whole core.
vi.mock('@plakboek/core', () => ({
  defineBlock: <T>(definition: T): T => definition,
}));

const { heading } = await import('../../template/blocks/heading.js');
const { section } = await import('../../template/blocks/section.js');

type Definition = { component: BlockComponent<Record<string, unknown>> };

function renderLive(
  definition: unknown,
  input: { id: string; blockType: string; kind: 'block' | 'section' },
  props: Record<string, unknown>,
): string {
  const { component } = definition as Definition;
  const edit = createLiveEdit({ ...input, label: input.blockType });
  return renderToStaticMarkup(
    component({
      block: { id: input.id, blockType: input.blockType, schemaVersion: 1 },
      props,
      edit,
      children: null,
      layout: {},
    }) as ReactElement,
  );
}

describe('the starter blocks in a live render', () => {
  it.each(['1', '2', '3'])(
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

  it('puts the identity of a section on its root element', () => {
    const markup = renderLive(
      section,
      { id: 'section-1', blockType: 'section', kind: 'section' },
      {},
    );
    expect(markup).toMatch(/^<section[^>]*data-pk-block="section-1"/);
  });
});
