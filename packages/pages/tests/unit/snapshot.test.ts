import { describe, expect, it } from 'vitest';
import {
  buildSnapshotTree,
  computeManifestHash,
  type PageSnapshot,
} from '../../src/publish.js';
import { defineBlocks } from '../../src/registry.js';
import type { BlockNode } from '../../src/types.js';

// Module-level registry: `buildSnapshotTree` resolves each node's
// declaration through `getBlockDefinition`/`resolveBlockProperties`, so a
// block type must be registered before a test builds a snapshot over it --
// mirrors every other unit suite in this package that exercises code
// reading the real registry (as opposed to `versioning.test.ts`'s
// hand-built `BlockDefinition`s, which bypass it entirely).
defineBlocks([
  {
    key: 'section',
    kind: 'section',
    editor: { label: 'Section' },
    schemaVersion: 1,
    properties: {},
  },
  {
    key: 'heading',
    editor: { label: 'Heading' },
    schemaVersion: 1,
    properties: {
      // Declared out of alphabetical order deliberately -- the fixtures
      // below supply raw props in the OPPOSITE order, proving
      // `buildSnapshotTree` emits keys in DECLARATION order, never
      // object-insertion order of the stored props.
      subtitle: {
        fieldType: 'short_text',
        label: 'Subtitle',
        options: { maxLength: 120 },
      },
      text: {
        fieldType: 'short_text',
        label: 'Text',
        options: { maxLength: 120 },
      },
    },
  },
]);

const now = new Date('2026-09-25T09:00:00.000Z');

function node(input: {
  readonly id: string;
  readonly blockType: string;
  readonly props: Record<string, unknown>;
  readonly sortOrder?: number;
  readonly schemaVersion?: number;
  readonly children?: readonly BlockNode[];
}): BlockNode {
  return {
    id: input.id,
    ownerType: 'page',
    ownerId: 'owner-1',
    locale: 'en',
    parentBlockId: null,
    blockType: input.blockType,
    props: input.props,
    schemaVersion: input.schemaVersion ?? 1,
    depth: 0,
    sortOrder: input.sortOrder ?? 1000,
    version: 1,
    createdAt: now,
    updatedAt: now,
    degraded: false,
    children: input.children ?? [],
  };
}

describe('buildSnapshotTree (D-16, D-30)', () => {
  it('nests a section containing two blocks, children in sort_order order, with no section-specific branch', () => {
    const heading1 = node({
      id: 'h1',
      blockType: 'heading',
      props: { text: 'A', subtitle: 'sub-a' },
      sortOrder: 1000,
    });
    const heading2 = node({
      id: 'h2',
      blockType: 'heading',
      props: { text: 'B', subtitle: 'sub-b' },
      sortOrder: 2000,
    });
    const section = node({
      id: 's1',
      blockType: 'section',
      props: {},
      children: [heading1, heading2],
    });

    const snapshot = buildSnapshotTree([section]);

    expect(snapshot).toEqual({
      blocks: [
        {
          id: 's1',
          blockType: 'section',
          schemaVersion: 1,
          props: {},
          children: [
            {
              id: 'h1',
              blockType: 'heading',
              schemaVersion: 1,
              props: { subtitle: 'sub-a', text: 'A' },
              children: [],
            },
            {
              id: 'h2',
              blockType: 'heading',
              schemaVersion: 1,
              props: { subtitle: 'sub-b', text: 'B' },
              children: [],
            },
          ],
        },
      ],
    });
  });

  it('emits props keys in the current declaration order, omitting keys the declaration no longer carries', () => {
    const heading = node({
      id: 'h1',
      blockType: 'heading',
      // Supplied in the OPPOSITE order to the declaration (subtitle,
      // text), plus a stale key ('legacy') the current declaration no
      // longer carries.
      props: { text: 'A', legacy: 'stale', subtitle: 'sub' },
    });

    const snapshot = buildSnapshotTree([heading]);

    expect(Object.keys(snapshot.blocks[0]?.props ?? {})).toEqual([
      'subtitle',
      'text',
    ]);
  });

  it('building the same node list twice produces byte-identical JSON.stringify output', () => {
    const heading = node({
      id: 'h1',
      blockType: 'heading',
      props: { text: 'A', subtitle: 'sub' },
    });

    const first = buildSnapshotTree([heading]);
    const second = buildSnapshotTree([heading]);

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  // Discrimination target: emitting `orderedProps` via
  // `Object.assign({}, rawProps)` (object-insertion order) instead of
  // iterating `resolveBlockProperties`'s own key order would make this
  // assertion fail for a fixture whose raw props are supplied out of
  // declaration order -- confirmed live during development, then reverted
  // to the declaration-order implementation above.
  it('two trees with the same props supplied in different insertion order still serialise identically', () => {
    const a: PageSnapshot = buildSnapshotTree([
      node({
        id: 'h1',
        blockType: 'heading',
        props: { text: 'A', subtitle: 'sub' },
      }),
    ]);
    const b: PageSnapshot = buildSnapshotTree([
      node({
        id: 'h1',
        blockType: 'heading',
        props: { subtitle: 'sub', text: 'A' },
      }),
    ]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('computeManifestHash (D-33)', () => {
  it('returns the same lowercase hex sha256 for the same manifest twice', () => {
    const manifest = { 'block-a': 'rev-1', 'block-b': 'rev-2' };
    const first = computeManifestHash(manifest);
    const second = computeManifestHash(manifest);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same value for manifests differing only in key order', () => {
    const manifestA = { 'block-a': 'rev-1', 'block-b': 'rev-2' };
    const manifestB = { 'block-b': 'rev-2', 'block-a': 'rev-1' };
    expect(computeManifestHash(manifestA)).toBe(computeManifestHash(manifestB));
  });

  it('returns a different value when a revision id changes, even with identical keys', () => {
    const manifestA = { 'block-a': 'rev-1' };
    const manifestB = { 'block-a': 'rev-2' };
    expect(computeManifestHash(manifestA)).not.toBe(
      computeManifestHash(manifestB),
    );
  });

  it('returns a different value for manifests with different keys but the same values', () => {
    const manifestA = { 'block-a': 'rev-1' };
    const manifestB = { 'block-b': 'rev-1' };
    expect(computeManifestHash(manifestA)).not.toBe(
      computeManifestHash(manifestB),
    );
  });
});
