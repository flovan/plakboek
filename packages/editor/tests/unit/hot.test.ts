import { describe, expect, it } from 'vitest';
import { diffSignatures, type SignatureMap } from '../../src/hot.js';

type Entry = readonly [string, string | null, string];

const signatures = (...entries: readonly Entry[]): SignatureMap =>
  new Map(
    entries.map(([id, parentId, own]) => [id, { parentId, own }] as const),
  );

describe('diffSignatures', () => {
  const base = signatures(
    ['section', null, '<section><!--pk:column--></section>'],
    ['column', 'section', '<div><!--pk:leaf--></div>'],
    ['leaf', 'column', '<p>one</p>'],
  );

  it('reports nothing for identical renders', () => {
    expect(diffSignatures(base, new Map(base))).toEqual({
      changed: [],
      structural: false,
    });
  });

  it('lists a leaf whose own markup changed', () => {
    const after = signatures(
      ['section', null, '<section><!--pk:column--></section>'],
      ['column', 'section', '<div><!--pk:leaf--></div>'],
      ['leaf', 'column', '<p>two</p>'],
    );
    expect(diffSignatures(base, after)).toEqual({
      changed: ['leaf'],
      structural: false,
    });
  });

  it('reduces a changed parent and child to the parent', () => {
    const after = signatures(
      ['section', null, '<section><!--pk:column--></section>'],
      ['column', 'section', '<div class="wide"><!--pk:leaf--></div>'],
      ['leaf', 'column', '<p>two</p>'],
    );
    expect(diffSignatures(base, after)).toEqual({
      changed: ['column'],
      structural: false,
    });
  });

  it('keeps two unrelated changes apart', () => {
    const before = signatures(['a', null, '<p>a</p>'], ['b', null, '<p>b</p>']);
    const after = signatures(['a', null, '<p>A</p>'], ['b', null, '<p>B</p>']);
    expect(diffSignatures(before, after).changed).toEqual(['a', 'b']);
  });

  it('is structural when a block is added', () => {
    const after = new Map(base).set('extra', {
      parentId: 'column',
      own: '<p>x</p>',
    });
    expect(diffSignatures(base, after)).toEqual({
      changed: [],
      structural: true,
    });
  });

  it('is structural when a block is removed', () => {
    const after = new Map(base);
    after.delete('leaf');
    expect(diffSignatures(base, after).structural).toBe(true);
  });

  it('is structural when a block is replaced by another with the same count', () => {
    const after = signatures(
      ['section', null, '<section><!--pk:column--></section>'],
      ['column', 'section', '<div><!--pk:other--></div>'],
      ['other', 'column', '<p>one</p>'],
    );
    expect(diffSignatures(base, after).structural).toBe(true);
  });

  it('is structural when a block is moved under another parent', () => {
    const after = signatures(
      ['section', null, '<section><!--pk:column--><!--pk:leaf--></section>'],
      ['column', 'section', '<div></div>'],
      ['leaf', 'section', '<p>one</p>'],
    );
    expect(diffSignatures(base, after)).toEqual({
      changed: [],
      structural: true,
    });
  });
});
