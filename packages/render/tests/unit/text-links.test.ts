import type { BlockDefinition } from '@plakboek/pages';
import { describe, expect, it } from 'vitest';
import { collectPageLinkIds } from '../../src/server.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const E = '55555555-5555-4555-8555-555555555555';

function doc(...marks: readonly string[]): unknown {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: marks.map((pageId) => ({
          type: 'text',
          text: 'x',
          marks: [
            { type: 'link', attrs: { href: null, pageId, target: null } },
          ],
        })),
      },
    ],
  };
}

const definitions = new Map<string, Pick<BlockDefinition, 'properties'>>([
  [
    'prose',
    { properties: { body: { fieldType: 'rich_text', label: 'Body' } } },
  ],
  [
    'button',
    {
      properties: {
        label: { fieldType: 'short_text', label: 'Label' },
        link: { fieldType: 'link', label: 'Link' },
      },
    },
  ],
  [
    'cards',
    {
      properties: {
        items: {
          fieldType: 'repeater',
          label: 'Items',
          options: {
            fields: [
              { key: 'title', label: 'Title', fieldType: 'short_text' },
              { key: 'text', label: 'Text', fieldType: 'rich_text' },
              { key: 'target', label: 'Target', fieldType: 'link' },
            ],
          },
        },
      },
    },
  ],
]);

type TestNode = {
  blockType: string;
  props: unknown;
  children: readonly TestNode[];
};

function node(
  blockType: string,
  props: unknown,
  children: readonly TestNode[] = [],
): TestNode {
  return { blockType, props, children };
}

describe('collectPageLinkIds', () => {
  it('collects rich text link ids and call-to-action ids, nested blocks included', () => {
    const withCta = {
      type: 'doc',
      content: [
        {
          type: 'cta',
          attrs: { label: 'Go', pageId: B, href: null, target: null },
        },
      ],
    };
    const ids = collectPageLinkIds(
      [node('prose', { body: doc(A) }, [node('prose', { body: withCta })])],
      definitions,
    );
    expect(ids).toEqual([A, B]);
  });

  it('collects the page id of a link field, and ignores an address link', () => {
    expect(
      collectPageLinkIds(
        [
          node('button', { link: { href: null, pageId: C, target: null } }),
          node('button', {
            link: { href: 'https://example.com', pageId: null },
          }),
        ],
        definitions,
      ),
    ).toEqual([C]);
  });

  it('walks repeater items through their sub-field declarations', () => {
    expect(
      collectPageLinkIds(
        [
          node('cards', {
            items: [
              { title: 'one', text: doc(D), target: { pageId: E, href: null } },
              { title: 'two', text: doc(), target: null },
            ],
          }),
        ],
        definitions,
      ),
    ).toEqual([D, E]);
  });

  it('lists a repeated id once, in first-seen order', () => {
    expect(
      collectPageLinkIds(
        [
          node('prose', { body: doc(B, A, B) }),
          node('button', { link: { href: null, pageId: A, target: null } }),
        ],
        definitions,
      ),
    ).toEqual([B, A]);
  });

  it('skips unknown block types and values that are not page ids', () => {
    expect(
      collectPageLinkIds(
        [
          node('mystery', { body: doc(A) }),
          node('button', { link: { href: null, pageId: 'not-a-uuid' } }),
          node('prose', {}),
        ],
        definitions,
      ),
    ).toEqual([]);
  });
});
