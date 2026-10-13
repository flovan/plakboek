import { describe, expect, it } from 'vitest';
import {
  planFragmentTargets,
  type TouchedIds,
} from '../../src/server/api/fragments.js';
import { block, buildNodes, column, section } from './support/model.js';

function touched(partial: Partial<TouchedIds>): TouchedIds {
  return {
    createdIds: [],
    deletedIds: [],
    updatedIds: [],
    movedIds: [],
    touchedParentIds: [],
    ...partial,
  };
}

const before = buildNodes([
  section('s1', [column('c1', [block('h1', 'heading'), block('t1', 'text')])]),
  section('s2', [column('c2', [block('h2', 'heading')])]),
  section('s3', [column('c3')]),
]);

describe('planFragmentTargets', () => {
  it('patches only the updated blocks for a batch of property updates', () => {
    const plan = planFragmentTargets({
      before,
      after: before,
      result: touched({ updatedIds: ['t1', 'h2'] }),
      structural: false,
    });
    expect(plan).toEqual({
      targets: ['t1', 'h2'],
      removed: [],
      rootOrder: null,
    });
  });

  it('patches the section of a move inside it', () => {
    const after = buildNodes([
      section('s1', [
        column('c1', [block('t1', 'text'), block('h1', 'heading')]),
      ]),
      section('s2', [column('c2', [block('h2', 'heading')])]),
      section('s3', [column('c3')]),
    ]);
    const plan = planFragmentTargets({
      before,
      after,
      result: touched({ movedIds: ['t1'], touchedParentIds: ['c1'] }),
      structural: true,
    });
    expect(plan).toEqual({ targets: ['s1'], removed: [], rootOrder: null });
  });

  it('patches both sections of a move across sections, in page order', () => {
    const after = buildNodes([
      section('s1', [column('c1', [block('t1', 'text')])]),
      section('s2', [column('c2', [block('h2', 'heading')])]),
      section('s3', [column('c3', [block('h1', 'heading')])]),
    ]);
    const plan = planFragmentTargets({
      before,
      after,
      result: touched({ movedIds: ['h1'], touchedParentIds: ['c1', 'c3'] }),
      structural: true,
    });
    expect(plan).toEqual({
      targets: ['s1', 's3'],
      removed: [],
      rootOrder: null,
    });
  });

  it('targets a new top level section and sends the new order', () => {
    const after = buildNodes([
      section('s1', [
        column('c1', [block('h1', 'heading'), block('t1', 'text')]),
      ]),
      section('s4', [column('c4')]),
      section('s2', [column('c2', [block('h2', 'heading')])]),
      section('s3', [column('c3')]),
    ]);
    const plan = planFragmentTargets({
      before,
      after,
      result: touched({ createdIds: ['s4', 'c4'], touchedParentIds: [null] }),
      structural: true,
    });
    expect(plan).toEqual({
      targets: ['s4'],
      removed: [],
      rootOrder: ['s1', 's4', 's2', 's3'],
    });
  });

  it('reports a deleted top level section as removed and sends the order', () => {
    const after = buildNodes([
      section('s1', [
        column('c1', [block('h1', 'heading'), block('t1', 'text')]),
      ]),
      section('s3', [column('c3')]),
    ]);
    const plan = planFragmentTargets({
      before,
      after,
      result: touched({
        deletedIds: ['s2', 'c2', 'h2'],
        touchedParentIds: [null],
      }),
      structural: true,
    });
    expect(plan).toEqual({
      targets: [],
      removed: ['s2'],
      rootOrder: ['s1', 's3'],
    });
  });

  it('patches the section of a nested block that was deleted', () => {
    const after = buildNodes([
      section('s1', [column('c1', [block('h1', 'heading')])]),
      section('s2', [column('c2', [block('h2', 'heading')])]),
      section('s3', [column('c3')]),
    ]);
    const plan = planFragmentTargets({
      before,
      after,
      result: touched({ deletedIds: ['t1'], touchedParentIds: ['c1'] }),
      structural: true,
    });
    expect(plan).toEqual({ targets: ['s1'], removed: [], rootOrder: null });
  });

  it('reports a moved top level section by its new order', () => {
    const after = buildNodes([
      section('s2', [column('c2', [block('h2', 'heading')])]),
      section('s1', [
        column('c1', [block('h1', 'heading'), block('t1', 'text')]),
      ]),
      section('s3', [column('c3')]),
    ]);
    const plan = planFragmentTargets({
      before,
      after,
      result: touched({ movedIds: ['s2'], touchedParentIds: [null] }),
      structural: true,
    });
    expect(plan.rootOrder).toEqual(['s2', 's1', 's3']);
    expect(plan.targets).toEqual(['s2']);
  });
});
