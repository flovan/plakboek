import {
  checkPlacement,
  defineBlocks,
  type BlockDefinition,
  type BlockDefinitionInput,
} from '@plakboek/pages';
import { describe, expect, it } from 'vitest';
import type { CatalogueEntry } from '../../src/api-types.js';
import {
  canPlace,
  decidePlacement,
  legalTypesAt,
  placementRefusal,
  type LegalityContext,
} from '../../src/client/session/legality.js';
import { createTreeModel } from '../../src/client/session/tree-model.js';
import { block, buildNodes, column, section } from './support/model.js';

const entry = (
  key: string,
  extra: Partial<BlockDefinitionInput> = {},
): BlockDefinitionInput => ({
  key,
  editor: { label: key },
  properties: {},
  schemaVersion: 1,
  ...extra,
});

const registered = defineBlocks([
  entry('section', { kind: 'section' }),
  entry('narrowSection', {
    kind: 'section',
    placement: { allowedChildren: ['text'] },
  }),
  entry('column', { kind: 'column' }),
  entry('text'),
  entry('quote', { layout: { fill: true } }),
  entry('accordionList', { placement: { allowedChildren: ['accordionItem'] } }),
  entry('accordionItem', {
    placement: { allowedParents: ['accordionList'], allowedChildren: 'any' },
  }),
  entry('wrapper', { placement: { allowedChildren: 'any' } }),
  entry('neverPlaced', { placement: { ownerTypes: [] } }),
]);

// defineBlocks refuses the "@root" sentinel as a declared key, so the one block
// that names it is built by hand, as the engine's own placement tests do.
const rootOnly: BlockDefinition = {
  ...registered.find((definition) => definition.key === 'text')!,
  key: 'rootOnly',
  placement: {
    ownerTypes: ['page'],
    allowedParents: ['@root'],
    allowedChildren: 'none',
  },
};
const definitions: readonly BlockDefinition[] = [...registered, rootOnly];

const byKey = new Map(
  definitions.map((definition) => [definition.key, definition]),
);

function definitionOf(key: string): BlockDefinition {
  const definition = byKey.get(key);
  if (definition === undefined) throw new Error(`no fixture block "${key}"`);
  return definition;
}

/** The catalogue entry the server would build from a registered definition. */
function toCatalogueEntry(definition: BlockDefinition): CatalogueEntry {
  return {
    key: definition.key,
    kind: definition.kind,
    editor: definition.editor,
    placement: definition.placement,
    supportsFill: definition.layoutSupport.fill,
    starterChildren: definition.starterChildren,
    properties: [],
  };
}

const catalogue = new Map(
  definitions.map((definition) => [
    definition.key,
    toCatalogueEntry(definition),
  ]),
);

function entryOf(key: string): CatalogueEntry {
  const found = catalogue.get(key);
  if (found === undefined) throw new Error(`no fixture entry "${key}"`);
  return found;
}

describe('decidePlacement matches the engine', () => {
  it('answers exactly what checkPlacement answers for every combination', () => {
    const keys = definitions.map((definition) => definition.key);
    const sectionKeys = keys.filter(
      (key) => definitionOf(key).kind === 'section',
    );
    let compared = 0;
    const mismatches: string[] = [];

    for (const childKey of keys) {
      for (const parentKey of [null, ...keys]) {
        const parentIsColumn =
          parentKey !== null && definitionOf(parentKey).kind === 'column';
        const sections: (string | null)[] = parentIsColumn
          ? [null, ...sectionKeys]
          : [null];
        for (const sectionKey of sections) {
          for (const parentDepth of [null, 0, 2, 11, 12]) {
            for (const parentSectionDepth of [0, 1, 2]) {
              for (const columnsEnabled of [true, false]) {
                const limits = {
                  sectionNestingDepth: 2,
                  blockDepthCeiling: 12,
                };
                const expected = checkPlacement({
                  ownerType: 'page',
                  child: definitionOf(childKey),
                  parent: parentKey === null ? null : definitionOf(parentKey),
                  section:
                    sectionKey === null ? null : definitionOf(sectionKey),
                  parentDepth,
                  parentSectionDepth,
                  columnsEnabled,
                  ...limits,
                });
                const actual = decidePlacement({
                  ownerType: 'page',
                  child: entryOf(childKey),
                  parent: parentKey === null ? null : entryOf(parentKey),
                  section: sectionKey === null ? null : entryOf(sectionKey),
                  parentDepth,
                  parentSectionDepth,
                  columnsEnabled,
                  ...limits,
                });
                if (actual !== expected) {
                  mismatches.push(
                    `${JSON.stringify({ childKey, parentKey, sectionKey, parentDepth, parentSectionDepth, columnsEnabled })}: engine ${String(expected)}, client ${String(actual)}`,
                  );
                }
                compared += 1;
              }
            }
          }
        }
      }
    }
    expect(mismatches.slice(0, 3)).toEqual([]);
    expect(compared).toBeGreaterThan(3000);
  });

  it('exercises every refusal reason the engine can give', () => {
    const reasons = new Set<string | null>();
    for (const child of definitions) {
      for (const parent of [null, ...definitions]) {
        for (const parentDepth of [null, 0, 12]) {
          for (const parentSectionDepth of [0, 2]) {
            reasons.add(
              checkPlacement({
                ownerType: 'page',
                child,
                parent,
                section:
                  parent?.kind === 'column' ? definitionOf('section') : null,
                parentDepth,
                parentSectionDepth,
                sectionNestingDepth: 2,
                blockDepthCeiling: 12,
                columnsEnabled: true,
              }),
            );
          }
        }
      }
    }
    expect(reasons).toEqual(
      new Set([
        null,
        'block-depth',
        'child-rejects-parent',
        'column-requires-section',
        'owner-type',
        'parent-rejects-child',
        'section-nesting',
        'section-requires-columns',
        'section-required',
      ]),
    );
  });
});

// s1 > c1 > [t1, al > ai > t2, ns > nc > nt]; s2 (narrow) > c2 > [t3, w2]; s3 > c3 > ns3 > nc3 > []
const nodes = buildNodes([
  section('s1', [
    column('c1', [
      block('t1', 'text'),
      block('al', 'accordionList', [
        block('ai', 'accordionItem', [block('t2', 'text')]),
      ]),
      section('ns', [column('nc', [block('nt', 'text')])], 'section'),
    ]),
  ]),
  section(
    's2',
    [column('c2', [block('t3', 'text'), block('w2', 'wrapper')])],
    'narrowSection',
  ),
  section('s3', [column('c3', [section('ns3', [column('nc3')])])]),
  section('s4', [
    column('c4', [block('w4', 'wrapper', [section('ns4', [column('nc4')])])]),
  ]),
]);
const model = createTreeModel(nodes);
const ctx: LegalityContext = {
  catalogue,
  model,
  limits: { sectionNestingDepth: 2, blockDepthCeiling: 12 },
  columnsEnabled: true,
};

describe('canPlace over a model', () => {
  it('equals the engine decision built from the registry definitions, for every parent and child', () => {
    const sectionsAbove = (id: string): number =>
      [id, ...model.ancestorsOf(id).map((node) => node.id)].filter(
        (nodeId) =>
          definitionOf(model.get(nodeId)?.type ?? '').kind === 'section',
      ).length;

    for (const parentId of [null, ...nodes.map((node) => node.id)]) {
      const parentNode = parentId === null ? undefined : model.get(parentId);
      for (const childKey of catalogue.keys()) {
        const parent =
          parentNode === undefined ? null : definitionOf(parentNode.type);
        const sectionNode =
          parentNode === undefined ? null : model.parentOf(parentNode.id);
        const expected = checkPlacement({
          ownerType: 'page',
          child: definitionOf(childKey),
          parent,
          section:
            parent?.kind === 'column' && sectionNode !== null
              ? definitionOf(sectionNode.type)
              : null,
          parentDepth: parentNode?.depth ?? null,
          parentSectionDepth: parentId === null ? 0 : sectionsAbove(parentId),
          sectionNestingDepth: 2,
          blockDepthCeiling: 12,
          columnsEnabled: true,
        });
        expect(
          placementRefusal(ctx, childKey, parentId),
          `${childKey} under ${String(parentId)}`,
        ).toBe(expected);
      }
    }
  });

  it('lists only the types a spot accepts', () => {
    expect(legalTypesAt(ctx, null)).toEqual(['section', 'narrowSection']);
    expect(legalTypesAt(ctx, 's1')).toEqual(['column']);
    expect(legalTypesAt(ctx, 'c2')).toEqual(['text']);
    expect(legalTypesAt(ctx, 'al')).toEqual(['accordionItem']);
    expect(legalTypesAt(ctx, 't1')).toEqual([]);
  });

  it('refuses an unknown type or parent', () => {
    expect(placementRefusal(ctx, 'mystery', 'c1')).toBe('unknown-type');
    expect(placementRefusal(ctx, 'text', 'missing')).toBe('unknown-parent');
  });
});

describe('canPlace for a move', () => {
  it('never offers a destination inside the moved item subtree', () => {
    expect(
      placementRefusal(ctx, 'accordionList', 'ai', { movingId: 'al' }),
    ).toBe('circular');
    expect(canPlace(ctx, 'accordionList', 'al', { movingId: 'al' })).toBe(
      false,
    );
    expect(placementRefusal(ctx, 'section', 'nc', { movingId: 's1' })).toBe(
      'circular',
    );
  });

  it('counts the sections the moved subtree carries along', () => {
    // A wrapper holding one section sits fine under a first-level section ...
    expect(canPlace(ctx, 'wrapper', 'c2', { movingId: 'w4' })).toBe(false);
    expect(canPlace(ctx, 'wrapper', 'c1', { movingId: 'w4' })).toBe(true);
    // ... but not two section levels deep, though the wrapper itself is a plain block.
    expect(placementRefusal(ctx, 'wrapper', 'nc3', { movingId: 'w4' })).toBe(
      'section-nesting',
    );
    expect(placementRefusal(ctx, 'wrapper', 'nc3')).toBeNull();
  });

  it('counts the height the moved subtree carries along', () => {
    const shallow: LegalityContext = {
      ...ctx,
      limits: { sectionNestingDepth: 2, blockDepthCeiling: 4 },
    };
    expect(placementRefusal(shallow, 'accordionList', 'w2')).toBeNull();
    expect(
      placementRefusal(shallow, 'accordionList', 'w2', { movingId: 'al' }),
    ).toBe('block-depth');
    expect(
      placementRefusal(shallow, 'accordionList', 'c2', { movingId: 'al' }),
    ).toBe('parent-rejects-child');
  });
});
