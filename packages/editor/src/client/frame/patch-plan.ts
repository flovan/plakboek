import type { Fragment, FragmentPatch } from '../../api-types.js';

/**
 * One DOM operation on the frame document. A server `FragmentPatch` is turned
 * into these by `planPatch` (pure, no DOM), and `applyPatchSteps` runs them.
 * Live property renders, structural results and the dev block swap all go
 * through this one list, so the inline-edit guard lives in one place.
 */
export type PatchStep =
  | { readonly kind: 'replace'; readonly id: string; readonly html: string }
  | { readonly kind: 'create-root'; readonly id: string; readonly html: string }
  | { readonly kind: 'remove'; readonly id: string }
  | { readonly kind: 'order-roots'; readonly order: readonly string[] }
  | { readonly kind: 'reload' };

/** What the planner needs to know about the frame, answered by the DOM. */
export type PatchDomView = {
  /** Whether a block element with this id is in the frame. */
  readonly has: (id: string) => boolean;
  /** Whether that element is, or contains, one marked as being edited. */
  readonly inlineEditing: (id: string) => boolean;
  /** Whether the frame has at least one top-level block element, which is
   * where a new top-level section can be placed. */
  readonly rootContainer: boolean;
};

export type PatchPlan = {
  readonly steps: readonly PatchStep[];
  /** Work held back for an element under inline edit, by id. A deferred
   * removal is a fragment with empty `html`. Pass it to the next call. */
  readonly deferred: ReadonlyMap<string, Fragment>;
};

const RELOAD: readonly PatchStep[] = Object.freeze([{ kind: 'reload' }]);

const isDeferredRemoval = (fragment: Fragment): boolean => fragment.html === '';

/**
 * Plans a patch (D-28) and holds back whatever would touch an element under
 * inline edit (D-30). Order of steps: released deferred work, removals,
 * fragments, then the order of the top-level sections. A fragment for an id a
 * newer patch also carries is dropped from `deferred`, so the newest wins. A
 * fragment that has no element to replace and is not a new top-level section
 * makes the whole plan a single `reload`: every other step would be moot.
 */
export function planPatch(
  patch: FragmentPatch,
  view: PatchDomView,
  deferred: ReadonlyMap<string, Fragment> = new Map(),
): PatchPlan {
  const steps: PatchStep[] = [];
  const held = new Map<string, Fragment>();
  const superseded = new Set([
    ...patch.fragments.map((fragment) => fragment.id),
    ...patch.removed,
  ]);

  for (const [id, fragment] of deferred) {
    if (superseded.has(id) || !view.has(id)) continue;
    if (view.inlineEditing(id)) {
      held.set(id, fragment);
      continue;
    }
    steps.push(
      isDeferredRemoval(fragment)
        ? { kind: 'remove', id }
        : { kind: 'replace', id, html: fragment.html },
    );
  }

  for (const id of patch.removed) {
    if (!view.has(id)) continue;
    if (view.inlineEditing(id)) held.set(id, { id, html: '' });
    else steps.push({ kind: 'remove', id });
  }

  const rootIds = new Set(patch.rootOrder ?? []);
  for (const fragment of patch.fragments) {
    if (view.has(fragment.id)) {
      if (view.inlineEditing(fragment.id)) held.set(fragment.id, fragment);
      else
        steps.push({ kind: 'replace', id: fragment.id, html: fragment.html });
    } else if (rootIds.has(fragment.id) && view.rootContainer) {
      steps.push({ kind: 'create-root', id: fragment.id, html: fragment.html });
    } else {
      return { steps: RELOAD, deferred: new Map() };
    }
  }

  if (patch.rootOrder !== null)
    steps.push({ kind: 'order-roots', order: patch.rootOrder });

  return { steps, deferred: held };
}
