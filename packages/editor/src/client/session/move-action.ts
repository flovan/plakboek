import type { CatalogueEntry } from '../../api-types.js';
import { moveColumnIntent } from './column-actions.js';
import { buildUndoEntry, type UndoEntry } from './inverse.js';
import type { LegalityContext } from './legality.js';
import { moveTarget, type MoveDirection } from './move-targets.js';
import type { Intent } from './save-queue.js';
import type { EditorState } from './store.js';

const catalogueMaps = new WeakMap<
  readonly CatalogueEntry[],
  ReadonlyMap<string, CatalogueEntry>
>();

/** The catalogue by block key, built once per session. */
export function catalogueByKey(
  catalogue: readonly CatalogueEntry[],
): ReadonlyMap<string, CatalogueEntry> {
  let map = catalogueMaps.get(catalogue);
  if (map === undefined) {
    map = new Map(catalogue.map((entry) => [entry.key, entry]));
    catalogueMaps.set(catalogue, map);
  }
  return map;
}

/** What the placement rules read from the session, or null before it has opened. */
export function legalityContextOf(state: EditorState): LegalityContext | null {
  const { session, model } = state;
  if (session === null || model === null) return null;
  return {
    catalogue: catalogueByKey(session.catalogue),
    model,
    limits: session.limits,
    columnsEnabled: session.columnsEnabled,
  };
}

/** The move of an item one step earlier or later, with its undo entry; null at the true start or end. */
export function moveActionFor(
  state: EditorState,
  id: string,
  direction: MoveDirection,
): { readonly intent: Intent; readonly entry: UndoEntry } | null {
  const ctx = legalityContextOf(state);
  if (ctx === null) return null;
  const position = moveTarget(ctx, id, direction);
  if (position === null) return null;
  // A column that changes section changes two column counts (D-05).
  const intent: Intent = moveColumnIntent(ctx.model, id, position);
  return {
    intent,
    entry: buildUndoEntry(intent, ctx.model, { kind: 'moved', itemId: id }),
  };
}
