import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { rootOfNode } from '../../client/chrome-host/shape.js';
import type { Box } from '../../client/overlay/geometry.js';
import { catalogueByKey } from '../../client/session/move-action.js';
import { selectCrumb } from '../../client/session/scope.js';
import { selectAndAnnounce } from '../../client/session/selection-announcement.js';
import {
  useEditorStore,
  type EditorStore,
} from '../../client/session/store.js';
import { labelOf } from '../../client/session/tree-model.js';
import type { TextController } from '../../client/text/controller.js';
import { AlertIcon } from '../icons.js';
import { formatString, STRINGS } from '../strings.js';

function boxStyle(box: Box): CSSProperties {
  return {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
  };
}

/** How far a marker sits inside its block's corner, and its height. */
const INSET = 4;
const MARKER_HEIGHT = 20;

export type NeedsInputMarkersProps = {
  readonly store: EditorStore;
  /** The boxes of the blocks, in the framed document's coordinates. */
  readonly boxes: ReadonlyMap<string, Box>;
  /** Starts typing on the page in a block's text field; without it a marker only opens the Properties. */
  readonly textController?: TextController;
};

/** The ids of the blocks that still lack a required value. */
export function needsInputIds(store: EditorStore): readonly string[] {
  const { model } = store.getState();
  if (model === null) return [];
  return model
    .documentOrder()
    .filter((node) => node.needsInput.length > 0)
    .map((node) => node.id);
}

type Placement = {
  readonly id: string;
  readonly box: Box;
};

/**
 * A marker inside the top-right corner of every block with a required value
 * missing. It is a pointer control in the interaction plane, below the
 * toolbar: pressing it selects its block and opens its Properties with focus
 * on the first empty required control, unless that one is a text the block
 * marks on the page, which it starts typing in instead. It takes no focus of its own (the
 * keyboard reaches the same place through the block's toolbar), and while a
 * drag runs or the delete confirmation is open it is drawn but takes no
 * pointer. It moves to the left corner where it would sit under the floating
 * toolbar, and stays inside the visible top while the top of its block is
 * scrolled away (`position: sticky` inside a wrapper over the block, so no
 * script follows the scroll). It is gone the moment the last required value is filled, because the
 * model says nothing is missing any more.
 */
export function NeedsInputMarkers(
  props: NeedsInputMarkersProps,
): ReactElement | null {
  const { store, boxes, textController } = props;
  const model = useEditorStore(store, (state) => state.model);
  const session = useEditorStore(store, (state) => state.session);
  const busy = useEditorStore(
    store,
    (state) => state.drag !== null || state.deleteRequest !== null,
  );
  const root = useRef<HTMLDivElement>(null);
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());

  const placements: Placement[] = [];
  if (model !== null) {
    for (const id of needsInputIds(store)) {
      const box = boxes.get(id);
      if (box !== undefined) placements.push({ id, box });
    }
  }

  // Whether the marker, at the right corner, would sit under the toolbar: its
  // width is only known once it is drawn. Everything is read from the frame
  // document's viewport, which is where the toolbar and the markers are.
  useLayoutEffect(() => {
    const element = root.current;
    const toolbar = rootOfNode(element)
      ?.querySelector('[data-toolbar]')
      ?.getBoundingClientRect();
    const next = new Set<string>();
    if (element !== null && toolbar !== undefined) {
      for (const marker of element.querySelectorAll<HTMLElement>(
        '[data-marker]',
      )) {
        const pin = marker.parentElement?.getBoundingClientRect();
        if (pin === undefined) continue;
        const right = pin.right - INSET;
        const top = marker.getBoundingClientRect().top;
        if (
          right - marker.offsetWidth < toolbar.right &&
          right > toolbar.left &&
          top < toolbar.bottom &&
          top + MARKER_HEIGHT > toolbar.top
        ) {
          next.add(marker.dataset.marker ?? '');
        }
      }
    }
    setFlipped((previous) =>
      previous.size === next.size && [...next].every((id) => previous.has(id))
        ? previous
        : next,
    );
  });

  const labelText = (id: string): string => {
    if (model === null || session === null) return '';
    const byKey = catalogueByKey(session.catalogue);
    const label = labelOf(model, byKey, id);
    return label.kind === 'column'
      ? formatString('label.column', { n: String(label.n) })
      : label.text;
  };

  if (placements.length === 0) return null;
  return (
    <div
      ref={root}
      className="contents"
      data-markers=""
      data-inert={busy ? '' : undefined}
    >
      {placements.map(({ id, box }) => {
        const left = flipped.has(id);
        return (
          <div
            key={id}
            className="pk-marker-pin"
            data-side={left ? 'left' : 'right'}
            style={boxStyle(box)}
          >
            <button
              type="button"
              tabIndex={-1}
              className="pk-marker"
              data-marker={id}
              data-side={left ? 'left' : 'right'}
              aria-label={formatString('marker.label', {
                label: labelText(id),
              })}
              onClick={() => {
                if (model === null) return;
                // A missing text is typed where it belongs: on the page.
                const missing = model.get(id)?.needsInput[0];
                const field =
                  missing === undefined
                    ? null
                    : (textController?.fieldFor(id, missing) ?? null);
                if (
                  missing !== undefined &&
                  field !== null &&
                  field.kind !== 'button' &&
                  textController?.enterField(id, missing) === true
                ) {
                  return;
                }
                selectAndAnnounce(store, selectCrumb(model, id));
                store.requestProperties(id);
              }}
            >
              <AlertIcon />
              {STRINGS['panel.needsInput']}
            </button>
          </div>
        );
      })}
    </div>
  );
}
