import {
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type ReactElement,
} from 'react';
import type { Box } from '../../../client/overlay/geometry.js';
import { slashPlacement } from '../../../client/overlay/slot-geometry.js';
import type { TextController } from '../../../client/text/controller.js';
import { STRINGS } from '../../strings.js';
import { INSERT_SHORTCUT, InsertIcon } from './insert-icons.js';
import { ariaShortcut, currentPlatform, shortcutLabel } from './shortcuts.js';

export type SlashMenuProps = {
  readonly controller: TextController;
  /** The part of the document the frame shows, in the framed document's coordinates. */
  readonly visible: Box;
};

const ROW =
  'flex h-10 w-full cursor-pointer items-center gap-2 px-3 text-body text-text aria-selected:bg-surface-muted';

/**
 * The '/' menu: a listbox of the items the field's theme allows, hung from the
 * typed `/query` (below it, above when there is more room there, 8px inside
 * the frame). It never takes focus: the field keeps the caret and the arrow
 * keys, Enter and Escape are handled by the field's own '/' plugin. Because
 * the field is what has the focus, the field is what names the listbox and
 * its active row for assistive technology while the menu is open.
 */
export function SlashMenu(props: SlashMenuProps): ReactElement | null {
  const { controller, visible } = props;
  const state = useSyncExternalStore(controller.subscribe, () =>
    controller.slash(),
  );
  const base = useId();
  const list = useRef<HTMLDivElement>(null);
  const activeIndex = state?.activeIndex ?? 0;
  const open = state !== null;
  const hasItems = (state?.items.length ?? 0) > 0;
  const listId = `${base}-list`;
  const idOf = (index: number): string => `${base}-${String(index)}`;

  // The field keeps the focus, so it takes the combobox attributes while the menu is open.
  useEffect(() => {
    if (!open) return undefined;
    const field = controller.editor()?.view.dom;
    if (field === undefined) return undefined;
    const before = field.getAttribute('role');
    field.setAttribute('role', 'combobox');
    field.setAttribute('aria-haspopup', 'listbox');
    field.setAttribute('aria-expanded', 'true');
    if (hasItems) field.setAttribute('aria-controls', listId);
    return () => {
      if (before === null) field.removeAttribute('role');
      else field.setAttribute('role', before);
      field.removeAttribute('aria-haspopup');
      field.removeAttribute('aria-expanded');
      field.removeAttribute('aria-controls');
    };
  }, [open, hasItems, listId, controller]);

  useEffect(() => {
    if (!open || !hasItems) return undefined;
    const field = controller.editor()?.view.dom;
    if (field === undefined) return undefined;
    field.setAttribute('aria-activedescendant', idOf(activeIndex));
    return () => {
      field.removeAttribute('aria-activedescendant');
    };
  }, [open, hasItems, activeIndex, controller]);

  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, state?.query]);

  if (state === null) return null;
  const placement = slashPlacement(state.rect, visible);
  const platform = currentPlatform();
  return (
    <div
      className="pk-picker"
      data-slash-menu=""
      data-side={placement.side}
      style={{
        left: placement.left,
        top: placement.top,
        maxHeight: placement.maxHeight,
        transform: placement.side === 'above' ? 'translateY(-100%)' : undefined,
      }}
    >
      {state.items.length === 0 ? (
        <p role="status" className="m-0 px-3 py-4 text-body text-text-muted">
          {STRINGS['text.slash.none']}
        </p>
      ) : (
        <div
          ref={list}
          id={listId}
          role="listbox"
          aria-label={STRINGS['text.slash.label']}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {state.items.map((item, index) => {
            const shortcut = INSERT_SHORTCUT[item.id];
            return (
              <div
                key={item.id}
                id={idOf(index)}
                role="option"
                aria-selected={index === activeIndex}
                aria-keyshortcuts={
                  shortcut === undefined
                    ? undefined
                    : ariaShortcut(shortcut, platform)
                }
                data-option={item.id}
                className={ROW}
                // The field keeps the caret while the pointer works the menu.
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onMouseMove={() => {
                  if (index !== activeIndex) state.activate(index);
                }}
                onClick={() => {
                  state.choose(item);
                }}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  <InsertIcon id={item.id} />
                </span>
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {shortcut === undefined ? null : (
                  <span
                    aria-hidden="true"
                    className="shrink-0 text-caption text-text-muted"
                  >
                    {shortcutLabel(shortcut, platform)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
