import type { CSSProperties, ReactElement } from 'react';
import type { Box } from '../../client/overlay/geometry.js';
import { siblingAxis } from '../../client/overlay/geometry.js';
import { slotGeometry } from '../../client/overlay/slot-geometry.js';
import {
  columnSlots,
  insertSlots,
  slotKey,
  type InsertSlot,
} from '../../client/session/insertion.js';
import { legalityContextOf } from '../../client/session/move-action.js';
import { itemText } from '../../client/session/structure-actions.js';
import {
  useEditorStore,
  type EditorStore,
} from '../../client/session/store.js';
import { PlusIcon } from '../icons.js';
import { formatString, STRINGS } from '../strings.js';

function boxStyle(box: Box): CSSProperties {
  return {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
  };
}

export type InsertPointsProps = {
  readonly store: EditorStore;
  /** The boxes of the siblings and their parent, in the shell's coordinates. */
  readonly boxes: ReadonlyMap<string, Box>;
  /** Called with the gap whose button was pressed. */
  readonly onOpen: (slot: InsertSlot) => void;
};

/**
 * The gaps between the siblings of the current scope, each a 16px band that
 * shows a line and a `+` button while the pointer is over it or focus is on
 * its button. Between sections the button adds a section, between blocks in a
 * column or items in a block it adds a block or item. While a section or one of
 * its columns is selected, the lines between its columns stay in view and add a
 * column at once, with no picker. The buttons stay out of
 * the tab order so a page of them is not a page of tab stops; the toolbar's
 * Add after and the `+` key are the keyboard path to the same picker.
 */
export function InsertPoints(props: InsertPointsProps): ReactElement | null {
  const { store, boxes, onOpen } = props;
  const state = useEditorStore(store, (current) => current);
  const ctx = legalityContextOf(state);
  if (ctx === null) return null;
  const openKey = state.picker === null ? null : slotKey(state.picker.slot);
  const columns = columnSlots(ctx, state.selection.selectedId);
  // The columns of one section run the same way: side by side, or stacked in a narrow one.
  const columnAxis = (slot: InsertSlot): 'horizontal' | 'vertical' => {
    const measured = ctx.model
      .childrenOf(slot.parentId)
      .map((column) => boxes.get(column.id))
      .filter((box): box is Box => box !== undefined);
    return measured.length < 2 ? 'horizontal' : siblingAxis(measured);
  };
  return (
    <>
      {[...insertSlots(ctx, state.selection.scopeId), ...columns].map(
        (slot) => {
          const always = slot.level === 'column';
          const geometry = slotGeometry(
            slot,
            boxes,
            always ? columnAxis(slot) : undefined,
          );
          if (geometry === null) return null;
          const key = slotKey(slot);
          const label =
            slot.level === 'section'
              ? STRINGS['insert.section']
              : slot.level === 'column'
                ? STRINGS['insert.column']
                : slot.previousId === null
                  ? STRINGS['insert.blockHere']
                  : formatString('insert.blockAfter', {
                      label: itemText(state, slot.previousId),
                    });
          return (
            <div
              key={key}
              className="pk-insert"
              data-insert=""
              data-line={geometry.line}
              data-open={openKey === key ? '' : undefined}
              data-always={always ? '' : undefined}
              style={boxStyle(geometry.band)}
            >
              <span className="pk-insert-line" aria-hidden="true" />
              <button
                type="button"
                tabIndex={-1}
                className="pk-insert-button"
                data-slot={key}
                aria-label={label}
                aria-haspopup="dialog"
                aria-expanded={openKey === key}
                onClick={() => {
                  onOpen(slot);
                }}
              >
                <span className="pk-insert-dot">
                  <PlusIcon />
                </span>
              </button>
            </div>
          );
        },
      )}
    </>
  );
}
