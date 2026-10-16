import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { isVisibleIn, type Box } from '../../client/overlay/geometry.js';
import { catalogueByKey } from '../../client/session/move-action.js';
import { selectCrumb } from '../../client/session/scope.js';
import { selectAndAnnounce } from '../../client/session/selection-announcement.js';
import {
  useEditorStore,
  type EditorStore,
} from '../../client/session/store.js';
import { labelOf } from '../../client/session/tree-model.js';
import { AlertIcon } from '../icons.js';
import { formatString, STRINGS } from '../strings.js';

/** How far a marker sits inside its block's corner, and its height. */
const INSET = 4;
const MARKER_HEIGHT = 20;

export type NeedsInputMarkersProps = {
  readonly store: EditorStore;
  /** The boxes of the blocks, in the shell's coordinates. */
  readonly boxes: ReadonlyMap<string, Box>;
  /** The frame's content box in the shell's coordinates. */
  readonly frame: Box;
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
 * on the first empty required control. It takes no focus of its own (the
 * keyboard reaches the same place through the block's toolbar), and while a
 * drag runs or the delete confirmation is open it is drawn but takes no
 * pointer. It moves to the left corner where it would sit under the floating
 * toolbar, and stays inside the frame while the top of its block is scrolled
 * away. It is gone the moment the last required value is filled, because the
 * model says nothing is missing any more.
 */
export function NeedsInputMarkers(
  props: NeedsInputMarkersProps,
): ReactElement | null {
  const { store, boxes, frame } = props;
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
      if (box !== undefined && isVisibleIn(box, frame)) {
        placements.push({ id, box });
      }
    }
  }

  // Whether the marker, at the right corner, would sit under the toolbar: its
  // width is only known once it is drawn.
  useLayoutEffect(() => {
    const element = root.current;
    const rootNode = element?.getRootNode();
    const toolbar =
      rootNode instanceof ShadowRoot || rootNode instanceof Document
        ? rootNode.querySelector('[data-toolbar]')?.getBoundingClientRect()
        : undefined;
    const next = new Set<string>();
    if (element !== null && toolbar !== undefined) {
      for (const marker of element.querySelectorAll<HTMLElement>(
        '[data-marker]',
      )) {
        const placed = placements.find(
          (entry) => entry.id === marker.dataset.marker,
        );
        if (placed === undefined) continue;
        const right = placed.box.left + placed.box.width - INSET;
        const top = marker.getBoundingClientRect().top;
        if (
          right - marker.offsetWidth < toolbar.right &&
          right > toolbar.left &&
          top < toolbar.bottom &&
          top + MARKER_HEIGHT > toolbar.top
        ) {
          next.add(placed.id);
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
        const top = Math.min(
          Math.max(box.top + INSET, frame.top + INSET),
          box.top + Math.max(box.height - MARKER_HEIGHT - INSET, INSET),
        );
        const left = flipped.has(id);
        const style: CSSProperties = left
          ? { left: box.left + INSET, top }
          : {
              left: box.left + box.width - INSET,
              top,
              transform: 'translateX(-100%)',
            };
        return (
          <button
            key={id}
            type="button"
            tabIndex={-1}
            className="pk-marker"
            data-marker={id}
            data-side={left ? 'left' : 'right'}
            style={style}
            aria-label={formatString('marker.label', { label: labelText(id) })}
            onClick={() => {
              if (model === null) return;
              selectAndAnnounce(store, selectCrumb(model, id));
              store.requestProperties(id);
            }}
          >
            <AlertIcon />
            {STRINGS['panel.needsInput']}
          </button>
        );
      })}
    </div>
  );
}
