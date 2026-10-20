import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import {
  fieldBarPlacement,
  type Box,
} from '../../../client/overlay/geometry.js';
import {
  useEditorStore,
  type EditorStore,
} from '../../../client/session/store.js';
import { CheckIcon } from '../../icons.js';
import { formatString, STRINGS } from '../../strings.js';
import { Tooltip } from '../../tooltip.js';
import { Crumbs, crumbKeys, crumbLayout, useRoving } from './crumbs.js';

export type FieldBarProps = {
  readonly store: EditorStore;
  /** The field being edited: its block, property key and label. */
  readonly blockId: string;
  readonly propertyKey: string;
  readonly label: string;
  /** The property's `maxLength`; no counter without one. */
  readonly maxLength?: number;
  /** The field's box in the framed document's coordinates. */
  readonly field: Box;
  /** The part of the document the frame shows, in the same coordinates. */
  readonly visible: Box;
  /** Done: ends the session like Enter. */
  readonly onDone: () => void;
};

export function boxStyle(box: Box): CSSProperties {
  return {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
  };
}

export const DONE_BUTTON =
  'flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-2 text-body font-semibold text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring';

/**
 * The compact bar of a short text field being edited: the block's crumbs, a
 * divider, the character counter (when the property has a maxLength) and Done.
 * It is placed by the field (8px above it, below when there is no room, pinned
 * inside a field taller than the frame) and follows the field, never the
 * caret. Its buttons keep the editor's focus: a press on them does not move it.
 */
export function FieldBar(props: FieldBarProps): ReactElement | null {
  const { store, blockId, propertyKey, label, maxLength, field, visible } =
    props;
  const model = useEditorStore(store, (state) => state.model);
  const session = useEditorStore(store, (state) => state.session);
  const live = useEditorStore(
    store,
    (state) => state.liveValues[blockId]?.[propertyKey],
  );
  const root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 40 });

  useLayoutEffect(() => {
    const element = root.current;
    if (element === null) return;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    setSize((previous) =>
      previous.width === width && previous.height === height
        ? previous
        : { width, height },
    );
  });

  const node = model?.get(blockId);
  const stored = typeof live === 'string' ? live : node?.props[propertyKey];
  const count = typeof stored === 'string' ? stored.length : 0;
  const atLimit = maxLength !== undefined && count >= maxLength;

  // The limit is announced once, when it is reached.
  const wasAtLimit = useRef(false);
  useEffect(() => {
    if (atLimit && !wasAtLimit.current) {
      store.announce(STRINGS['text.announce.limit']);
    }
    wasAtLimit.current = atLimit;
  }, [atLimit, store]);

  const layout =
    model === null || session === null
      ? null
      : crumbLayout(model, session, blockId);
  const { rove, onKeyDown } = useRoving([
    ...(layout === null ? [] : crumbKeys(layout, blockId)),
    'done',
  ]);
  if (model === null || layout === null) return null;

  const placement = fieldBarPlacement({
    field,
    visible,
    height: size.height,
    width: size.width,
  });
  const pinned = placement.mode === 'pinned';
  const maxWidth = Math.max(0, visible.width - 16);
  return (
    // The wrapper is always there so the bar keeps its place in the tree when
    // it changes side. Pinned, it spans the field and the bar sticks inside it.
    <div
      className="pk-toolbar-pin"
      data-pinned={pinned ? '' : undefined}
      style={pinned ? boxStyle(field) : undefined}
    >
      <div
        ref={root}
        className="pk-toolbar"
        data-toolbar=""
        data-field-bar=""
        data-placement={placement.mode}
        role="toolbar"
        aria-label={formatString('text.fieldBar.label', { label })}
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        // A press on the bar leaves the caret where it is.
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) event.preventDefault();
        }}
        style={
          pinned
            ? { maxWidth }
            : { left: placement.left, top: placement.top, maxWidth }
        }
      >
        <Crumbs
          store={store}
          model={model}
          selectedId={blockId}
          layout={layout}
          rove={rove}
        />
        <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
        {maxLength === undefined ? null : (
          <span
            data-field-counter=""
            data-at-limit={atLimit ? '' : undefined}
            className={`shrink-0 px-1 text-caption font-semibold ${
              atLimit ? 'text-attention' : 'text-text-muted'
            }`}
          >
            {atLimit
              ? STRINGS['text.counter.limit']
              : formatString('text.counter', {
                  count: String(count),
                  max: String(maxLength),
                })}
          </span>
        )}
        <Tooltip
          label={STRINGS['text.done.tooltip']}
          placement={placement.mode === 'below' ? 'top' : 'bottom'}
        >
          <button
            type="button"
            className={DONE_BUTTON}
            aria-label={STRINGS['text.done.label']}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={props.onDone}
            {...rove('done')}
          >
            <CheckIcon />
            {STRINGS['text.done']}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
