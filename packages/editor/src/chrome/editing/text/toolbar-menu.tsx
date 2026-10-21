import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { formatString, STRINGS } from '../../strings.js';
import { Tooltip } from '../../tooltip.js';
import type { Rove } from './crumbs.js';
import { useOutsidePress } from './outside-press.js';

/** A 32px icon button of the toolbar that opens a menu. */
const MENU_BUTTON =
  'flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring aria-expanded:bg-surface-muted aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent';

/** A 40px row of a toolbar menu. */
export const MENU_ROW =
  'flex h-10 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-body text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring';

export type ToolbarMenuProps = {
  /** The roving id of the button. */
  readonly id: string;
  /** The accessible name of the button and of the menu, and the tooltip. */
  readonly label: string;
  readonly icon: ReactNode;
  readonly rove: Rove;
  readonly tooltipSide: 'top' | 'bottom';
  /** After a choice made with the keyboard, focus goes back to the field. */
  readonly onReturn: () => void;
  /** A Button is selected: the button is shown but opens nothing. */
  readonly disabled?: boolean;
  /** The rows: `choose(action)` makes the click handler of one. */
  readonly children: (
    choose: (action: () => void) => (event: MouseEvent) => void,
  ) => ReactNode;
};

/**
 * A 32px toolbar button and its 200px menu of 40px rows, shared by the Insert
 * and More menus. A press keeps the field's focus; from the keyboard the
 * button opens the menu onto its first row, the arrows move, Enter chooses and
 * Escape closes back to the button. The menu hangs below the button and flips
 * to its right edge when it would leave the frame.
 */
export function ToolbarMenu(props: ToolbarMenuProps): ReactElement {
  const { id, label, icon, rove, tooltipSide, onReturn, children } = props;
  const disabled = props.disabled === true;
  const [open, setOpen] = useState(false);
  const [alignEnd, setAlignEnd] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  /** Whether the menu was opened from the keyboard, so focus goes into it. */
  const withKeyboard = useRef(false);

  const rows = (): HTMLElement[] => [
    ...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ??
      []),
  ];

  useEffect(() => {
    if (!open || !withKeyboard.current) return;
    rows()[0]?.focus();
  }, [open]);

  // Hung from the button's left edge, the menu may pass the frame's right edge.
  // Closing puts it back on the left edge, so each open measures from there.
  useLayoutEffect(() => {
    const element = menu.current;
    if (!open || element === null) {
      setAlignEnd(false);
      return;
    }
    const view = element.ownerDocument.defaultView;
    if (view === null) return;
    setAlignEnd(element.getBoundingClientRect().right > view.innerWidth - 8);
  }, [open]);

  // A press anywhere else closes the menu.
  useOutsidePress(wrapper, () => setOpen(false), { enabled: open });

  const closeToButton = (): void => {
    setOpen(false);
    button.current?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeToButton();
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const all = rows();
    const at = all.findIndex((row) => row === event.target);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? all.length - 1
          : (at + (event.key === 'ArrowDown' ? 1 : -1) + all.length) %
            all.length;
    all[next]?.focus();
  };

  const choose =
    (action: () => void) =>
    (event: MouseEvent): void => {
      setOpen(false);
      action();
      // Chosen with the keyboard: the field has the focus back.
      if (event.detail === 0) onReturn();
    };

  return (
    <span ref={wrapper} className="relative inline-flex">
      <Tooltip
        label={disabled ? STRINGS['text.disabled.button'] : label}
        placement={tooltipSide}
        enabled={!open}
      >
        <button
          ref={button}
          type="button"
          className={MENU_BUTTON}
          aria-label={
            disabled
              ? formatString('text.disabled.buttonLabel', { name: label })
              : label
          }
          aria-disabled={disabled ? true : undefined}
          aria-haspopup="menu"
          aria-expanded={open && !disabled}
          data-menu-button={id}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={(event) => {
            // A click made by Enter or Space has no pointer detail.
            if (disabled) return;
            withKeyboard.current = event.detail === 0;
            setOpen(!open);
          }}
          onKeyDown={(event) => {
            if (disabled) return;
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              event.stopPropagation();
              withKeyboard.current = true;
              setOpen(true);
            }
          }}
          {...rove(id)}
        >
          {icon}
        </button>
      </Tooltip>
      {open && !disabled ? (
        <div
          ref={menu}
          role="menu"
          aria-label={label}
          className="pk-toolbar-menu w-[200px]"
          data-toolbar-menu={id}
          style={alignEnd ? { left: 'auto', right: 0 } : undefined}
          onKeyDown={onMenuKeyDown}
        >
          {children(choose)}
        </div>
      ) : null}
    </span>
  );
}
