import { describe, expect, it } from 'vitest';
import { wrapSeedColumns } from '../../src/runtime/bootstrap.js';
import type { SeedBlock } from '../../src/types.js';

const kinds = new Map([
  ['section', 'section'],
  ['column', 'column'],
  ['heading', 'block'],
]);

const heading: SeedBlock = { type: 'heading', props: { text: 'Hi' } };

describe('wrapSeedColumns', () => {
  it('wraps the blocks of a flat section in one column, in order', () => {
    const second: SeedBlock = { type: 'heading', props: { text: 'Two' } };
    expect(
      wrapSeedColumns(
        [{ type: 'section', children: [heading, second] }],
        kinds,
      ),
    ).toEqual([
      {
        type: 'section',
        children: [{ type: 'column', children: [heading, second] }],
      },
    ]);
  });

  it('gives an empty section one empty column', () => {
    expect(wrapSeedColumns([{ type: 'section' }], kinds)).toEqual([
      { type: 'section', children: [{ type: 'column' }] },
    ]);
  });

  it('leaves explicit columns alone and wraps sections nested in a column', () => {
    const nested: SeedBlock = { type: 'section', children: [heading] };
    expect(
      wrapSeedColumns(
        [
          {
            type: 'section',
            children: [{ type: 'column', children: [nested] }],
          },
        ],
        kinds,
      ),
    ).toEqual([
      {
        type: 'section',
        children: [
          {
            type: 'column',
            children: [
              {
                type: 'section',
                children: [{ type: 'column', children: [heading] }],
              },
            ],
          },
        ],
      },
    ]);
  });
});
