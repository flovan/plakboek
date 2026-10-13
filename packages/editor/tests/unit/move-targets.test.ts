import { describe, expect, it } from 'vitest';
import type { LegalityContext } from '../../src/client/session/legality.js';
import {
  moveTarget,
  moveTargetReason,
} from '../../src/client/session/move-targets.js';
import { createTreeModel } from '../../src/client/session/tree-model.js';
import {
  block,
  buildNodes,
  catalogueEntry,
  column,
  section,
  type Spec,
} from './support/model.js';

const entries = [
  catalogueEntry('section', 'section'),
  catalogueEntry('narrowSection', 'section', { allowedChildren: ['text'] }),
  catalogueEntry('column', 'column'),
  catalogueEntry('text', 'block'),
  catalogueEntry('quote', 'block'),
  catalogueEntry('accordionList', 'block', {
    allowedChildren: ['accordionItem'],
  }),
  catalogueEntry('accordionItem', 'block', {
    allowedParents: ['accordionList'],
    allowedChildren: 'any',
  }),
];

function contextFor(roots: readonly Spec[]): LegalityContext {
  return {
    catalogue: new Map(entries.map((entry) => [entry.key, entry])),
    model: createTreeModel(buildNodes(roots)),
    limits: { sectionNestingDepth: 2, blockDepthCeiling: 12 },
    columnsEnabled: true,
  };
}

// A: ca1 [t1, t2], ca2 [t3]   B: cb [t4]
const page = contextFor([
  section('A', [
    column('ca1', [block('t1', 'text'), block('t2', 'text')]),
    column('ca2', [block('t3', 'text')]),
  ]),
  section('B', [column('cb', [block('t4', 'text')])]),
]);

describe('moving inside the parent', () => {
  it('passes one sibling', () => {
    expect(moveTarget(page, 't1', 'later')).toEqual({
      parentId: 'ca1',
      previousId: 't2',
      nextId: null,
    });
    expect(moveTarget(page, 't2', 'earlier')).toEqual({
      parentId: 'ca1',
      previousId: null,
      nextId: 't1',
    });
  });

  it('moves a section past its neighbour at the page root', () => {
    expect(moveTarget(page, 'A', 'later')).toEqual({
      parentId: null,
      previousId: 'B',
      nextId: null,
    });
    expect(moveTarget(page, 'B', 'earlier')).toEqual({
      parentId: null,
      previousId: null,
      nextId: 'A',
    });
  });

  it('moves a section nested in a column inside that column', () => {
    const nested = contextFor([
      section('A', [
        column('c', [
          block('t', 'text'),
          section('ns', [column('nc')]),
          block('u', 'text'),
        ]),
      ]),
    ]);
    expect(moveTarget(nested, 'ns', 'later')).toEqual({
      parentId: 'c',
      previousId: 'u',
      nextId: null,
    });
    expect(moveTarget(nested, 'ns', 'earlier')).toEqual({
      parentId: 'c',
      previousId: null,
      nextId: 't',
    });
  });
});

describe('moving across boundaries', () => {
  it('moves the last block of a column to the top of the next column', () => {
    expect(moveTarget(page, 't2', 'later')).toEqual({
      parentId: 'ca2',
      previousId: null,
      nextId: 't3',
    });
  });

  it('moves the last block of a section to the first column of the next section', () => {
    expect(moveTarget(page, 't3', 'later')).toEqual({
      parentId: 'cb',
      previousId: null,
      nextId: 't4',
    });
  });

  it('moves the first block of a column to the end of the previous column and section', () => {
    expect(moveTarget(page, 't3', 'earlier')).toEqual({
      parentId: 'ca1',
      previousId: 't2',
      nextId: null,
    });
    expect(moveTarget(page, 't4', 'earlier')).toEqual({
      parentId: 'ca2',
      previousId: 't3',
      nextId: null,
    });
  });

  it('moves a column from the end of its section into the next section', () => {
    expect(moveTarget(page, 'ca2', 'later')).toEqual({
      parentId: 'B',
      previousId: null,
      nextId: 'cb',
    });
    expect(moveTarget(page, 'cb', 'earlier')).toEqual({
      parentId: 'A',
      previousId: 'ca2',
      nextId: null,
    });
  });

  it('enters the previous container itself, not a section nested at its end', () => {
    const nested = contextFor([
      section('A', [
        column('c1', [
          block('t1', 'text'),
          section('ns', [column('nc', [block('nt', 'text')])]),
        ]),
        column('c2', [block('t2', 'text')]),
      ]),
    ]);
    expect(moveTarget(nested, 't2', 'earlier')).toEqual({
      parentId: 'c1',
      previousId: 'ns',
      nextId: null,
    });
  });

  it('does not leave a nested section for its own ancestor column', () => {
    const nested = contextFor([
      section('A', [
        column('c1', [
          block('t0', 'text'),
          section('ns', [column('nc', [block('nt', 'text')])]),
        ]),
      ]),
    ]);
    expect(moveTarget(nested, 'nt', 'earlier')).toBeNull();
  });

  it('moves an accordion item into the next accordion list', () => {
    const accordions = contextFor([
      section('A', [
        column('c', [
          block('al1', 'accordionList', [
            block('i1', 'accordionItem'),
            block('i2', 'accordionItem'),
          ]),
          block('al2', 'accordionList', [block('i3', 'accordionItem')]),
        ]),
      ]),
    ]);
    expect(moveTarget(accordions, 'i2', 'later')).toEqual({
      parentId: 'al2',
      previousId: null,
      nextId: 'i3',
    });
    expect(moveTarget(accordions, 'i3', 'earlier')).toEqual({
      parentId: 'al1',
      previousId: 'i2',
      nextId: null,
    });
  });

  it('skips a container whose section refuses the block', () => {
    const skipping = contextFor([
      section('A', [column('ca', [block('q', 'quote')])]),
      section('B', [column('cb', [block('t', 'text')])], 'narrowSection'),
      section('C', [column('cc', [block('u', 'text')])]),
    ]);
    expect(moveTarget(skipping, 'q', 'later')).toEqual({
      parentId: 'cc',
      previousId: null,
      nextId: 'u',
    });
    // A text block is accepted by the narrow section.
    expect(moveTarget(skipping, 't', 'earlier')).toEqual({
      parentId: 'ca',
      previousId: 'q',
      nextId: null,
    });
  });
});

describe('the true ends', () => {
  it('answers null at the start and end of the page', () => {
    expect(moveTarget(page, 't1', 'earlier')).toBeNull();
    expect(moveTarget(page, 't4', 'later')).toBeNull();
    expect(moveTarget(page, 'A', 'earlier')).toBeNull();
    expect(moveTarget(page, 'B', 'later')).toBeNull();
    expect(moveTarget(page, 'ca1', 'earlier')).toBeNull();
  });

  it('answers null when every later container refuses the item', () => {
    const refused = contextFor([
      section('A', [column('ca', [block('q', 'quote')])]),
      section('B', [column('cb', [block('t', 'text')])], 'narrowSection'),
    ]);
    expect(moveTarget(refused, 'q', 'later')).toBeNull();
  });

  it('names the reason for the toolbar', () => {
    expect(moveTargetReason(page, 't1', 'earlier')).toBe('atStart');
    expect(moveTargetReason(page, 't4', 'later')).toBe('atEnd');
    expect(moveTargetReason(page, 't2', 'later')).toBeNull();
    expect(moveTargetReason(page, 'missing', 'later')).toBe('atEnd');
  });
});
