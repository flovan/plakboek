import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import type { Editor } from '@tiptap/core';
import type { TextTheme } from '@plakboek/content/rich-text';
import {
  fieldBarPlacement,
  type Box,
} from '../../../client/overlay/geometry.js';
import type { EditorStore } from '../../../client/session/store.js';
import type { TextController } from '../../../client/text/controller.js';
import { BoldIcon, CheckIcon } from '../../icons.js';
import { formatString, STRINGS } from '../../strings.js';
import { Tooltip } from '../../tooltip.js';
import { useRoving } from './crumbs.js';
import { boxStyle, DONE_BUTTON } from './field-bar.js';
import { toolbarModel, type ToggleId } from './toolbar-state.js';

export type TextToolbarProps = {
  readonly controller: TextController;
  readonly store: EditorStore;
  /** The label of the property being edited, for the toolbar's name. */
  readonly label: string;
  /** The property's effective theme: what the toolbar offers. */
  readonly theme: TextTheme;
  /** The field's box in the framed document's coordinates. */
  readonly field: Box;
  /** The part of the document the frame shows, in the same coordinates. */
  readonly visible: Box;
};

/** A 32px toggle; pressed it takes the inverted fill, never colour alone (aria-pressed). */
const TOGGLE =
  'flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring aria-pressed:bg-text aria-pressed:text-surface aria-pressed:hover:bg-text';

const TOGGLES = {
  bold: {
    name: 'text.mark.bold',
    Icon: BoldIcon,
    run: (editor: Editor) => editor.chain().toggleBold().run(),
  },
} as const;

/**
 * The floating toolbar of the rich text field being edited. It replaces the
 * block toolbar and is placed by the field (above it, below when there is no
 * room, pinned inside a field taller than the frame); it follows the field,
 * never the caret, so it stays put while the selection moves inside it. Its
 * buttons keep the field's focus and selection: a press does not move focus.
 * What it offers is the property's effective theme, nothing else.
 */
export function TextToolbar(props: TextToolbarProps): ReactElement | null {
  const { controller, store, label, theme, field, visible } = props;
  const root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 40 });

  // Every transaction gives a new editor state, which redraws the toolbar.
  const state = useSyncExternalStore(
    controller.subscribe,
    () => controller.editor()?.state ?? null,
  );

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

  const model = toolbarModel({
    theme,
    isActive: (name, attributes) =>
      controller.editor()?.isActive(name, attributes) ?? false,
  });
  const keys = [...model.marks.map((toggle) => toggle.id), 'done'];
  const { rove, onKeyDown: roveKeys } = useRoving(keys);

  // Alt+F10 in the field lands on the toolbar's current control.
  useEffect(() => {
    controller.setToolbarFocus(() => {
      root.current
        ?.querySelector<HTMLElement>('[data-roving][tabindex="0"]')
        ?.focus();
    });
    return () => {
      controller.setToolbarFocus(null);
    };
  }, [controller]);

  if (state === null) return null;

  const toggle = (id: ToggleId): void => {
    const editor = controller.editor();
    if (editor === null) return;
    const control = TOGGLES[id];
    control.run(editor);
    store.announce(
      formatString(
        editor.isActive(id) ? 'text.announce.on' : 'text.announce.off',
        { name: STRINGS[control.name] },
      ),
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (
      event.key === 'Escape' &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      // Back to the field, its selection as it was; a second Escape ends it.
      event.preventDefault();
      event.stopPropagation();
      controller.focusField();
      return;
    }
    roveKeys(event);
  };

  const placement = fieldBarPlacement({
    field,
    visible,
    height: size.height,
    width: size.width,
  });
  const pinned = placement.mode === 'pinned';
  const maxWidth = Math.max(0, visible.width - 16);
  const tooltipSide = placement.mode === 'below' ? 'top' : 'bottom';
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
        data-text-toolbar=""
        data-placement={placement.mode}
        role="toolbar"
        aria-label={formatString('text.toolbar.label', { label })}
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
        {model.marks.map((control) => {
          const { name, Icon } = TOGGLES[control.id];
          return (
            <Tooltip
              key={control.id}
              label={STRINGS[name]}
              placement={tooltipSide}
            >
              <button
                type="button"
                className={TOGGLE}
                aria-label={STRINGS[name]}
                aria-pressed={control.pressed}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  toggle(control.id);
                }}
                {...rove(control.id)}
              >
                <Icon />
              </button>
            </Tooltip>
          );
        })}
        <Tooltip label={STRINGS['text.done.tooltip']} placement={tooltipSide}>
          <button
            type="button"
            className={DONE_BUTTON}
            aria-label={STRINGS['text.done.label']}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              void controller.exit('done');
            }}
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
