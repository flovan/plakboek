/**
 * `normaliseSnapshotColumns` (D-03): a snapshot published before the column
 * kind existed is wrapped in memory so it renders on the column grid. Pure;
 * the database side of the upgrade is covered by the integration suite.
 */
import { describe, expect, it } from 'vitest';
import { normaliseSnapshotColumns } from '../../src/columns.js';
import type { SnapshotBlock } from '../../src/publish.js';
import { defineBlocks } from '../../src/registry.js';

const column = {
  key: 'column',
  kind: 'column' as const,
  editor: { label: 'Column' },
  schemaVersion: 3,
  upcasters: { 2: (props: unknown) => props, 3: (props: unknown) => props },
  properties: {},
};
const section = {
  key: 'section',
  kind: 'section' as const,
  editor: { label: 'Section' },
  schemaVersion: 1,
  properties: {},
};
const text = {
  key: 'text',
  editor: { label: 'Text' },
  schemaVersion: 1,
  properties: {},
};

function node(
  id: string,
  blockType: string,
  children: readonly SnapshotBlock[] = [],
): SnapshotBlock {
  return { id, blockType, schemaVersion: 1, props: {}, children };
}

describe('normaliseSnapshotColumns', () => {
  it('wraps a flat section in one synthetic column keeping the order', () => {
    defineBlocks([column, section, text]);
    const input = [
      node('s1', 'section', [node('a', 'text'), node('b', 'text')]),
    ];

    const result = normaliseSnapshotColumns(input);

    expect(result).toHaveLength(1);
    const wrapped = result[0]?.children;
    expect(wrapped).toHaveLength(1);
    expect(wrapped?.[0]).toMatchObject({
      id: 's1:column',
      blockType: 'column',
      schemaVersion: 3,
      props: {},
    });
    expect(wrapped?.[0]?.children.map((child) => child.id)).toEqual(['a', 'b']);
    expect(input[0]?.children.map((child) => child.id)).toEqual(['a', 'b']);
  });

  it('recurses into a nested section', () => {
    defineBlocks([column, section, text]);
    const input = [
      node('outer', 'section', [
        node('a', 'text'),
        node('inner', 'section', [node('b', 'text')]),
      ]),
    ];

    const result = normaliseSnapshotColumns(input);

    const outerColumn = result[0]?.children[0];
    expect(outerColumn?.children.map((child) => child.id)).toEqual([
      'a',
      'inner',
    ]);
    const innerColumn = outerColumn?.children[1]?.children[0];
    expect(innerColumn?.id).toBe('inner:column');
    expect(innerColumn?.children.map((child) => child.id)).toEqual(['b']);
  });

  it('returns the very same array when the snapshot already has columns', () => {
    defineBlocks([column, section, text]);
    const input = [
      node('s1', 'section', [node('c1', 'column', [node('a', 'text')])]),
    ];

    expect(normaliseSnapshotColumns(input)).toBe(input);
  });

  it('leaves everything alone when the registry has no column kind', () => {
    defineBlocks([section, text]);
    const input = [node('s1', 'section', [node('a', 'text')])];

    expect(normaliseSnapshotColumns(input)).toBe(input);
  });
});
