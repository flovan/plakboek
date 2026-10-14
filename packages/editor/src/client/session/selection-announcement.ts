import type { CatalogueEntry } from '../../api-types.js';
import { formatString, STRINGS } from '../../chrome/strings.js';
import type { Selection } from './scope.js';
import type { EditorStore } from './store.js';
import { labelOf, type ItemLabel, type TreeModel } from './tree-model.js';

function textOf(label: ItemLabel): string {
  return label.kind === 'column'
    ? formatString('label.column', { n: String(label.n) })
    : label.text;
}

/**
 * What a screen reader hears when the selection moves: the item's name, where
 * it sits among its siblings and what it sits in, with "Needs input" added
 * when a required value is still missing. A top-level section is announced by
 * its position among the page's sections. Nothing is announced for an empty
 * selection.
 */
export function announceSelection(
  model: TreeModel,
  catalogue: readonly CatalogueEntry[],
  selection: Selection,
): string {
  const { selectedId } = selection;
  if (selectedId === null) return '';
  const node = model.get(selectedId);
  if (node === undefined) return '';
  const byKey = new Map(catalogue.map((entry) => [entry.key, entry]));
  const label = textOf(labelOf(model, byKey, node.id));
  const place = model.siblingIndex(node.id);
  const position = String((place?.index ?? 0) + 1);
  const total = String(place?.total ?? 1);
  const parent = model.parentOf(node.id);
  const sentence =
    parent === null
      ? formatString('announce.selectedSection', { label, position, total })
      : formatString('announce.selected', {
          label,
          position,
          total,
          parent: textOf(labelOf(model, byKey, parent.id)),
        });
  return node.needsInput.length > 0
    ? `${sentence}${STRINGS['announce.needsInput']}`
    : sentence;
}

/** Moves the selection and tells the live region about it. */
export function selectAndAnnounce(
  store: EditorStore,
  selection: Selection,
): void {
  const before = store.getState().selection;
  store.select(selection);
  const state = store.getState();
  if (state.selection === before || state.model === null) return;
  store.announce(
    announceSelection(
      state.model,
      state.session?.catalogue ?? [],
      state.selection,
    ),
  );
}
