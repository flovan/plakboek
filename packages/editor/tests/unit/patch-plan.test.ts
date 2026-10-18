import { describe, expect, it } from 'vitest';
import type { Fragment, FragmentPatch } from '../../src/api-types.js';
import {
  planPatch,
  type PatchDomView,
} from '../../src/client/frame/patch-plan.js';

function view(
  present: readonly string[],
  editing: readonly string[] = [],
  rootContainer = true,
): PatchDomView {
  return {
    has: (id) => present.includes(id),
    inlineEditing: (id) => editing.includes(id),
    rootContainer,
  };
}

const patch = (partial: Partial<FragmentPatch>): FragmentPatch => ({
  fragments: [],
  removed: [],
  rootOrder: null,
  ...partial,
});

const fragment = (id: string, html = `<p data-pk-block="${id}">x</p>`) => ({
  id,
  html,
});

describe('planPatch', () => {
  it('replaces a block that is in the frame', () => {
    const plan = planPatch(
      patch({ fragments: [fragment('a', '<p>new</p>')] }),
      view(['a']),
    );
    expect(plan.steps).toEqual([
      { kind: 'replace', id: 'a', html: '<p>new</p>' },
    ]);
    expect(plan.deferred.size).toBe(0);
  });

  it('creates a new top-level section, then orders the sections', () => {
    const plan = planPatch(
      patch({ fragments: [fragment('b')], rootOrder: ['b', 'a'] }),
      view(['a']),
    );
    expect(plan.steps.map((step) => step.kind)).toEqual([
      'create-root',
      'order-roots',
    ]);
    expect(plan.steps[1]).toEqual({ kind: 'order-roots', order: ['b', 'a'] });
  });

  it('removes a deleted section, then orders the rest', () => {
    const plan = planPatch(
      patch({ removed: ['b'], rootOrder: ['a'] }),
      view(['a', 'b']),
    );
    expect(plan.steps).toEqual([
      { kind: 'remove', id: 'b' },
      { kind: 'order-roots', order: ['a'] },
    ]);
  });

  it('skips the removal of an element that is already gone', () => {
    expect(planPatch(patch({ removed: ['b'] }), view(['a'])).steps).toEqual([]);
  });

  it('reloads when a nested fragment has no element to replace', () => {
    const plan = planPatch(
      patch({ fragments: [fragment('child')], rootOrder: ['a'] }),
      view(['a']),
    );
    expect(plan.steps).toEqual([{ kind: 'reload' }]);
  });

  it('reloads when a new section has no top-level container to join', () => {
    const plan = planPatch(
      patch({ fragments: [fragment('b')], rootOrder: ['b'] }),
      view([], [], false),
    );
    expect(plan.steps).toEqual([{ kind: 'reload' }]);
  });

  it('lets reload short-circuit every other step', () => {
    const plan = planPatch(
      patch({
        fragments: [fragment('a'), fragment('lost')],
        removed: ['c'],
        rootOrder: ['a'],
      }),
      view(['a', 'c']),
    );
    expect(plan.steps).toEqual([{ kind: 'reload' }]);
    expect(plan.deferred.size).toBe(0);
  });

  describe('inline editing (D-30)', () => {
    it('defers a replace of an element under inline edit', () => {
      const plan = planPatch(
        patch({ fragments: [fragment('a')] }),
        view(['a'], ['a']),
      );
      expect(plan.steps).toEqual([]);
      expect([...plan.deferred.keys()]).toEqual(['a']);
    });

    it('defers a removal of an element that contains an edited one', () => {
      const plan = planPatch(patch({ removed: ['a'] }), view(['a'], ['a']));
      expect(plan.steps).toEqual([]);
      expect(plan.deferred.get('a')).toEqual({ id: 'a', html: '' });
    });

    it('lets a newer fragment for the same id supersede a deferred one', () => {
      const old: ReadonlyMap<string, Fragment> = new Map([
        ['a', fragment('a', '<p>old</p>')],
      ]);
      const plan = planPatch(
        patch({ fragments: [fragment('a', '<p>newer</p>')] }),
        view(['a'], ['a']),
        old,
      );
      expect(plan.steps).toEqual([]);
      expect(plan.deferred.get('a')?.html).toBe('<p>newer</p>');
    });

    it('drops a deferred fragment when a newer one is applied at once', () => {
      const old: ReadonlyMap<string, Fragment> = new Map([
        ['a', fragment('a', '<p>old</p>')],
      ]);
      const plan = planPatch(
        patch({ fragments: [fragment('a', '<p>newer</p>')] }),
        view(['a']),
        old,
      );
      expect(plan.steps).toEqual([
        { kind: 'replace', id: 'a', html: '<p>newer</p>' },
      ]);
      expect(plan.deferred.size).toBe(0);
    });

    it('keeps a deferred fragment while the mark stands', () => {
      const old: ReadonlyMap<string, Fragment> = new Map([
        ['a', fragment('a', '<p>old</p>')],
      ]);
      const plan = planPatch(patch({}), view(['a'], ['a']), old);
      expect(plan.steps).toEqual([]);
      expect(plan.deferred.get('a')).toEqual(old.get('a'));
    });

    it('releases a deferred fragment, before new work, once the mark is gone', () => {
      const old: ReadonlyMap<string, Fragment> = new Map([
        ['a', fragment('a', '<p>old</p>')],
        ['b', { id: 'b', html: '' }],
      ]);
      const plan = planPatch(
        patch({ fragments: [fragment('c', '<p>c</p>')] }),
        view(['a', 'b', 'c']),
        old,
      );
      expect(plan.steps).toEqual([
        { kind: 'replace', id: 'a', html: '<p>old</p>' },
        { kind: 'remove', id: 'b' },
        { kind: 'replace', id: 'c', html: '<p>c</p>' },
      ]);
      expect(plan.deferred.size).toBe(0);
    });

    it('drops a deferred fragment whose element is gone', () => {
      const old: ReadonlyMap<string, Fragment> = new Map([
        ['a', fragment('a')],
      ]);
      const plan = planPatch(patch({}), view([]), old);
      expect(plan.steps).toEqual([]);
      expect(plan.deferred.size).toBe(0);
    });
  });
});
