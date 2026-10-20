import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { CheckIcon, ChevronDownIcon } from '../../icons.js';
import { formatString, STRINGS, type StringKey } from '../../strings.js';
import { Tooltip } from '../../tooltip.js';
import type { Rove } from './crumbs.js';
import { ariaShortcut, type Platform } from './shortcuts.js';
import type { StyleId } from './toolbar-state.js';

export type StyleMenuProps = {
  readonly current: StyleId;
  /** The rows: Paragraph, then each heading style the theme allows. */
  readonly options: readonly StyleId[];
  readonly onChoose: (style: StyleId) => void;
  /** After a choice made with the keyboard, focus goes back to the field. */
  readonly onReturn: () => void;
  readonly rove: Rove;
  readonly platform: Platform;
  readonly tooltipSide: 'top' | 'bottom';
};

const BUTTON =
  'flex h-8 w-[112px] cursor-pointer items-center justify-between gap-1 rounded-md border-0 bg-transparent pr-1 pl-2 text-body font-semibold text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring';

const ROW =
  'flex h-10 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-body text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring';

const NAME = {
  paragraph: 'text.style.paragraph',
  title: 'text.style.title',
  heading: 'text.style.heading',
  subheading: 'text.style.subheading',
} as const satisfies Record<StyleId, StringKey>;

/**
 * The Text style button and its menu: a 112px button that always shows the
 * current style in full, and a 200px menu of 40px rows, a check on the current
 * one. A press keeps the field's focus; from the keyboard the button opens the
 * menu onto the current row, the arrows move, Enter chooses and Escape closes
 * back to the button.
 */
export function StyleMenu(props: StyleMenuProps): ReactElement {
  const { current, options, onChoose, onReturn, rove, platform, tooltipSide } =
    props;
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  /** Whether the menu was opened from the keyboard, so focus goes into it. */
  const withKeyboard = useRef(false);

  const rows = (): HTMLElement[] => [
    ...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
  ];

  useEffect(() => {
    if (!open || !withKeyboard.current) return;
    const all = rows();
    (all.find((row) => row.dataset.current === '') ?? all[0])?.focus();
  }, [open]);

  // A press anywhere else closes the menu.
  useEffect(() => {
    if (!open) return undefined;
    const element = wrapper.current;
    if (element === null) return undefined;
    const onPress = (event: Event): void => {
      if (!event.composedPath().includes(element)) setOpen(false);
    };
    const owner = element.ownerDocument;
    owner.addEventListener('pointerdown', onPress, true);
    return () => {
      owner.removeEventListener('pointerdown', onPress, true);
    };
  }, [open]);

  const openWithKeyboard = (): void => {
    withKeyboard.current = true;
    setOpen(true);
  };

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

  const name = STRINGS[NAME[current]];
  return (
    <span ref={wrapper} className="relative inline-flex">
      <Tooltip
        label={STRINGS['text.style.tooltip']}
        placement={tooltipSide}
        enabled={!open}
      >
        <button
          ref={button}
          type="button"
          className={BUTTON}
          aria-label={formatString('text.style.label', { style: name })}
          aria-haspopup="menu"
          aria-expanded={open}
          data-style-button=""
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={(event) => {
            // A click made by Enter or Space has no pointer detail.
            withKeyboard.current = event.detail === 0;
            setOpen(!open);
          }}
          onKeyDown={(event) => {
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              event.stopPropagation();
              openWithKeyboard();
            }
          }}
          {...rove('style')}
        >
          <span>{name}</span>
          <ChevronDownIcon />
        </button>
      </Tooltip>
      {open ? (
        <div
          ref={menu}
          role="menu"
          aria-label={STRINGS['text.style.tooltip']}
          className="pk-toolbar-menu w-[200px]"
          data-style-menu=""
          onKeyDown={onMenuKeyDown}
        >
          {options.map((style) => {
            const isCurrent = style === current;
            return (
              <button
                key={style}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={ROW}
                aria-current={isCurrent ? 'true' : undefined}
                aria-keyshortcuts={ariaShortcut(style, platform)}
                data-current={isCurrent ? '' : undefined}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={(event) => {
                  setOpen(false);
                  onChoose(style);
                  // Chosen with the keyboard: the field has the focus back.
                  if (event.detail === 0) onReturn();
                }}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {isCurrent ? <CheckIcon /> : null}
                </span>
                {STRINGS[NAME[style]]}
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}
