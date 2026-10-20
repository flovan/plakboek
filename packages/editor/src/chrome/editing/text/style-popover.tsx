import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Tooltip } from '../../tooltip.js';
import type { Rove } from './crumbs.js';

/** A 40px row of a Custom style popover. */
export const POPOVER_ROW =
  'flex h-10 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-body text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring';

/** A 32px menu button of the Custom style row that opens a popover. */
export const POPOVER_BUTTON =
  'flex h-8 w-24 cursor-pointer items-center justify-between gap-1 rounded-md border-0 bg-transparent pr-1 pl-2 text-body font-semibold text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring aria-expanded:bg-surface-muted';

export type PopoverApi = {
  /** Closes the popover without touching the field's focus. */
  readonly close: () => void;
  /** The click handler of an item: closes, runs the action, and hands the focus back after a keyboard choice. */
  readonly choose: (action: () => void) => (event: MouseEvent) => void;
  /** Closes and puts the caret back in the field, for a value typed into the popover. */
  readonly closeToField: () => void;
};

export type StylePopoverProps = {
  /** The roving id of the button. */
  readonly id: string;
  /** The accessible name of the button, also naming the popover. */
  readonly label: string;
  readonly tooltip: string;
  /** What the button shows. */
  readonly button: ReactNode;
  readonly rove: Rove;
  readonly tooltipSide: 'top' | 'bottom';
  /** Puts focus back in the field with its selection. */
  readonly onReturn: () => void;
  readonly children: (api: PopoverApi) => ReactNode;
};

/**
 * A 96px menu button of the Custom style row and the 320px popover it opens,
 * capped at 320px tall. A press keeps the field's focus; from the keyboard the
 * button opens the popover onto the current item, the arrows move over the
 * items, and Escape closes back to the field with its selection. The popover
 * hangs from the button's left edge and flips to its right edge when it would
 * leave the frame; a press anywhere else closes it.
 */
export function StylePopover(props: StylePopoverProps): ReactElement {
  const { id, label, tooltip, button, rove, tooltipSide, onReturn, children } =
    props;
  const [open, setOpen] = useState(false);
  const [alignEnd, setAlignEnd] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  /** Whether the popover was opened from the keyboard, so focus goes into it. */
  const withKeyboard = useRef(false);

  const items = (): HTMLElement[] => [
    ...(popover.current?.querySelectorAll<HTMLElement>('[data-pop-item]') ??
      []),
  ];

  useEffect(() => {
    if (!open || !withKeyboard.current) return;
    const all = items();
    (all.find((item) => item.dataset['current'] === '') ?? all[0])?.focus();
  }, [open]);

  // Closing puts the popover back on the left edge, so each open measures from there.
  useLayoutEffect(() => {
    const element = popover.current;
    if (!open || element === null) {
      setAlignEnd(false);
      return;
    }
    const view = element.ownerDocument.defaultView;
    if (view === null) return;
    setAlignEnd(element.getBoundingClientRect().right > view.innerWidth - 8);
  }, [open]);

  // A press anywhere else closes the popover.
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

  const closeToField = (): void => {
    setOpen(false);
    onReturn();
  };

  // Escape closes the popover and nothing else, wherever the focus is: a
  // popover opened with the pointer leaves it in the field, where a second
  // Escape would otherwise end the field session. The listener runs in the
  // capture phase so the field's own Escape never sees the key.
  useEffect(() => {
    if (!open) return undefined;
    const element = wrapper.current;
    if (element === null) return undefined;
    const owner = element.ownerDocument;
    const onEscape = (event: globalThis.KeyboardEvent): void => {
      if (
        event.key !== 'Escape' ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      onReturn();
    };
    owner.addEventListener('keydown', onEscape, true);
    return () => {
      owner.removeEventListener('keydown', onEscape, true);
    };
  }, [open, onReturn]);

  const onPopoverKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (
      ![
        'ArrowDown',
        'ArrowUp',
        'ArrowLeft',
        'ArrowRight',
        'Home',
        'End',
      ].includes(event.key)
    ) {
      return;
    }
    const all = items();
    const at = all.findIndex((item) => item === event.target);
    // Inside the typed input the arrows belong to the caret.
    if (at === -1) return;
    event.preventDefault();
    event.stopPropagation();
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? all.length - 1
          : (at + (forward ? 1 : -1) + all.length) % all.length;
    all[next]?.focus();
  };

  const api: PopoverApi = {
    close: () => {
      setOpen(false);
    },
    closeToField,
    choose: (action) => (event) => {
      setOpen(false);
      action();
      // Chosen with the keyboard: the field has the focus back.
      if (event.detail === 0) onReturn();
    },
  };

  return (
    <span ref={wrapper} className="relative inline-flex">
      <Tooltip label={tooltip} placement={tooltipSide} enabled={!open}>
        <button
          ref={trigger}
          type="button"
          className={POPOVER_BUTTON}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-popover-button={id}
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
              withKeyboard.current = true;
              setOpen(true);
            }
          }}
          {...rove(id)}
        >
          {button}
        </button>
      </Tooltip>
      {open ? (
        <div
          ref={popover}
          role="dialog"
          aria-label={label}
          className="pk-toolbar-menu max-h-[320px] w-[320px]"
          data-popover={id}
          style={alignEnd ? { left: 'auto', right: 0 } : undefined}
          onKeyDown={onPopoverKeyDown}
        >
          {children(api)}
        </div>
      ) : null}
    </span>
  );
}

export type CustomValueInputProps = {
  /** The visible and accessible label ("Custom size", "Custom color"). */
  readonly label: string;
  readonly hint: string;
  readonly error: string;
  /** The stored value of the text, or null when it is not valid. */
  readonly parse: (text: string) => string | null;
  /** Called with each valid value as it is typed. */
  readonly onApply: (value: string) => void;
  /** Called after Enter on a valid value: closes the popover and returns to the field. */
  readonly onDone: () => void;
  /** What sits before the input (the colour preview). */
  readonly before?: ReactNode;
  /** What sits after the input (the unit). */
  readonly after?: string;
  readonly inputMode: 'numeric' | 'text';
  /** The input's own stable marker for the tests and the keyboard. */
  readonly name: string;
};

/**
 * The pinned custom input under a popover's divider. A valid value applies as
 * it is typed; an invalid one is not applied, so the last valid value stays,
 * and says why once the input is left or Enter is pressed. A press in the
 * input takes the focus from the field (the selection lives on in the
 * editor's state), and Enter or Escape hands it back.
 */
export function CustomValueInput(props: CustomValueInputProps): ReactElement {
  const {
    label,
    hint,
    error,
    parse,
    onApply,
    onDone,
    before,
    after,
    inputMode,
    name,
  } = props;
  const [text, setText] = useState('');
  const [showError, setShowError] = useState(false);
  const inputId = useId();
  const noteId = useId();
  const invalid = showError && text.trim() !== '' && parse(text) === null;
  return (
    <div className="flex shrink-0 flex-col gap-1 border-t border-border px-2 pt-2 pb-1">
      <label htmlFor={inputId} className="text-body font-semibold text-text">
        {label}
      </label>
      <div className="flex h-10 items-center gap-2">
        {before}
        <input
          id={inputId}
          type="text"
          inputMode={inputMode}
          autoComplete="off"
          spellCheck={false}
          value={text}
          data-custom-input={name}
          aria-invalid={invalid}
          aria-describedby={noteId}
          className="h-10 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-body text-text focus-visible:outline-2 focus-visible:outline-focus-ring"
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            const value = parse(next);
            if (value !== null) {
              setShowError(false);
              onApply(value);
            }
          }}
          onBlur={() => {
            setShowError(true);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            event.stopPropagation();
            const value = parse(text);
            if (value === null) {
              setShowError(true);
              return;
            }
            onApply(value);
            onDone();
          }}
        />
        {after === undefined ? null : (
          <span className="text-body text-text-muted">{after}</span>
        )}
      </div>
      <p
        id={noteId}
        role={invalid ? 'alert' : undefined}
        className={`m-0 text-caption ${invalid ? 'text-destructive' : 'text-text-muted'}`}
      >
        {invalid ? error : hint}
      </p>
    </div>
  );
}
