import type { CSSProperties, ReactElement } from 'react';
import type { Box } from '../../client/overlay/geometry.js';
import type { InsertSlot } from '../../client/session/insertion.js';
import {
  useEditorStore,
  type EditorStore,
} from '../../client/session/store.js';
import { PlusIcon } from '../icons.js';
import { STRINGS } from '../strings.js';

function boxStyle(box: Box): CSSProperties {
  return {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
  };
}

const SECONDARY_BUTTON =
  'flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-control-border bg-surface px-4 text-body font-semibold text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

const PRIMARY_BUTTON =
  'flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-0 bg-accent px-4 text-body font-semibold text-accent-contrast whitespace-nowrap hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

export type EmptyPromptsProps = {
  readonly store: EditorStore;
  /** The ids of the columns the render marked empty. */
  readonly empty: readonly string[];
  /** The boxes of those columns, in the shell's coordinates. */
  readonly boxes: ReadonlyMap<string, Box>;
  /** The frame's content box in the shell's coordinates. */
  readonly frame: Box;
  /** Called with the gap whose prompt was pressed. */
  readonly onOpen: (
    slot: InsertSlot,
    opener: 'empty-column' | 'empty-page',
  ) => void;
};

/**
 * What an empty place on the page offers: a dashed box with "Add block" over
 * every column that holds nothing, and, on a page with no sections, a card
 * with "Add a section". A prompt goes as soon as its container has a child.
 * The cell itself stays clickable through the box, so a click still selects
 * the column.
 */
export function EmptyPrompts(props: EmptyPromptsProps): ReactElement | null {
  const { store, empty, boxes, frame, onOpen } = props;
  const model = useEditorStore(store, (state) => state.model);
  if (model === null) return null;

  const pageEmpty = model.size === 0;
  return (
    <>
      {empty.map((id) => {
        const box = boxes.get(id);
        const node = model.get(id);
        // A column that holds only a degraded or unknown block is not empty.
        if (
          box === undefined ||
          node === undefined ||
          node.kind !== 'column' ||
          model.childrenOf(id).length > 0
        ) {
          return null;
        }
        const slot: InsertSlot = {
          parentId: id,
          previousId: null,
          nextId: null,
          level: 'block',
        };
        return (
          <div
            key={id}
            className="pk-empty-box"
            data-empty-box={id}
            style={boxStyle(box)}
          >
            <button
              type="button"
              className={SECONDARY_BUTTON}
              data-empty-add={id}
              aria-haspopup="dialog"
              onClick={() => {
                onOpen(slot, 'empty-column');
              }}
            >
              <PlusIcon />
              {STRINGS['empty.column.add']}
            </button>
          </div>
        );
      })}
      {pageEmpty ? (
        <div className="pk-empty-page" style={boxStyle(frame)}>
          <div className="pk-empty-card" data-empty-page="">
            <h2 className="m-0 text-heading font-semibold text-text">
              {STRINGS['empty.page.heading']}
            </h2>
            <p className="mt-2 mb-4 text-body text-text-muted">
              {STRINGS['empty.page.body']}
            </p>
            <button
              type="button"
              className={PRIMARY_BUTTON}
              data-empty-page-add=""
              aria-haspopup="dialog"
              onClick={() => {
                onOpen(
                  {
                    parentId: null,
                    previousId: null,
                    nextId: null,
                    level: 'section',
                  },
                  'empty-page',
                );
              }}
            >
              <PlusIcon />
              {STRINGS['empty.page.add']}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
