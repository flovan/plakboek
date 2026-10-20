import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import type { Editor } from '@tiptap/core';
import type { TextTheme } from '@plakboek/content/rich-text';
import type { Box } from '../../../client/overlay/geometry.js';
import { slashPlacement } from '../../../client/overlay/slot-geometry.js';
import type { EditorStore } from '../../../client/session/store.js';
import type { TextController } from '../../../client/text/controller.js';
import {
  caretAfterCta,
  CTA_LABEL_MAX_LENGTH,
  ctaTargetOf,
  removeCta,
  selectedCta,
} from '../../../client/text/cta.js';
import { STRINGS } from '../../strings.js';
import { POPOVER_BUTTON } from './link-popover.js';
import { LinkTargetEditor, SEGMENT } from './link-target-editor.js';
import { LINK_INPUT, type PageSearch } from './page-picker.js';

export type ButtonPopoverProps = {
  readonly controller: TextController;
  readonly store: EditorStore;
  /** The property's theme: the variants a button can take. */
  readonly theme: TextTheme;
  /** The part of the document the frame shows, in the framed document's coordinates. */
  readonly visible: Box;
  /** The locale of the page being edited: the pages a button may point at. */
  readonly locale: string;
  /** Finds pages for the picker; without it only web addresses can be linked. */
  readonly search?: PageSearch;
};

/** The tallest the popover grows: the page list scrolls inside it past this. */
const POPOVER_MAX_HEIGHT = 480;

/** Up to this many variants are a segmented control, past it a native select. */
const SEGMENTED_MAX = 3;

/** The selected button's box in the framed document's coordinates, or null when it is not drawn. */
function ctaBox(editor: Editor, pos: number): Box | null {
  try {
    const { view } = editor;
    const dom = view.nodeDOM(pos) as Partial<HTMLElement> | null;
    if (dom === null || typeof dom.getBoundingClientRect !== 'function') {
      return null;
    }
    const rect = dom.getBoundingClientRect();
    const owner = view.dom.ownerDocument.defaultView;
    return {
      left: rect.left + (owner?.scrollX ?? 0),
      top: rect.top + (owner?.scrollY ?? 0),
      width: rect.width,
      height: rect.height,
    };
  } catch {
    // The view is mid-teardown; the popover goes with it.
    return null;
  }
}

/**
 * The Button popover: a 320px non-modal dialog hung below the selected CTA
 * (above it when there is more room there, 8px inside the frame). Everything
 * is applied as it is edited: the label, the variant and the link target go
 * straight onto the node, so the CTA in the field and the stored document
 * follow. Remove button deletes the node (Control+Z brings it back) and Done
 * puts the caret on the line below. Escape and a press anywhere else only
 * close the popover.
 */
export function ButtonPopover(props: ButtonPopoverProps): ReactElement | null {
  const { controller, store, theme, visible, locale, search } = props;
  const root = useRef<HTMLDivElement>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const noteId = useId();
  const styleId = useId();
  const [label, setLabel] = useState(() => {
    const editor = controller.editor();
    const attrs: unknown =
      editor === null ? null : selectedCta(editor.state)?.node.attrs;
    const value =
      typeof attrs === 'object' && attrs !== null
        ? Reflect.get(attrs, 'label')
        : '';
    return typeof value === 'string' ? value : '';
  });

  // The label is ready to be replaced: focused, its text selected.
  useEffect(() => {
    labelInput.current?.focus();
    labelInput.current?.select();
  }, []);

  // Escape closes the popover and nothing else, wherever the focus is; a press
  // anywhere but here closes it as well.
  useEffect(() => {
    const element = root.current;
    if (element === null) return undefined;
    const owner = element.ownerDocument;
    const onKey = (event: globalThis.KeyboardEvent): void => {
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
      controller.closeButton();
      controller.focusField();
    };
    const onPress = (event: Event): void => {
      if (event.composedPath().includes(element)) return;
      // A press on a control that keeps the field's focus must not leave the
      // focus on the label that is about to disappear.
      // (inside a shadow root the focused element is that root's, not the document's)
      const root = element.getRootNode() as Document | ShadowRoot;
      const hadFocus = element.contains(root.activeElement);
      controller.closeButton();
      if (hadFocus) controller.focusField();
    };
    owner.addEventListener('keydown', onKey, true);
    owner.addEventListener('pointerdown', onPress, true);
    return () => {
      owner.removeEventListener('keydown', onKey, true);
      owner.removeEventListener('pointerdown', onPress, true);
    };
  }, [controller]);

  const editor = controller.editor();
  const selected = editor === null ? null : selectedCta(editor.state);
  if (editor === null || selected === null) return null;
  const anchor = ctaBox(editor, selected.pos);
  if (anchor === null) return null;
  const placement = slashPlacement(anchor, visible, POPOVER_MAX_HEIGHT);

  const attrs: Readonly<Record<string, unknown>> = selected.node.attrs;
  const variants = theme.ctaVariants;
  const variant =
    typeof attrs['variant'] === 'string'
      ? attrs['variant']
      : (variants[0]?.value ?? '');
  const target = ctaTargetOf(attrs);
  const empty = label.trim() === '';

  const close = (): void => {
    controller.closeButton();
    controller.focusField();
  };

  const choose = (next: string): void => {
    editor.commands.updateCta({ variant: next });
  };

  const onSegmentKeys = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const at = variants.findIndex((entry) => entry.value === variant);
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const next =
      variants[(at + (forward ? 1 : -1) + variants.length) % variants.length];
    if (next === undefined) return;
    choose(next.value);
    // The newly selected radio is the one tab stop; focus follows the selection.
    const group = event.currentTarget;
    requestAnimationFrame(() => {
      group
        .querySelector<HTMLElement>(`[data-variant="${next.value}"]`)
        ?.focus();
    });
  };

  const done = (): void => {
    const tr = caretAfterCta(editor.state);
    if (tr !== null) editor.view.dispatch(tr);
    close();
  };

  const remove = (): void => {
    const tr = removeCta(editor.state);
    if (tr === null) return;
    editor.view.dispatch(tr);
    close();
    store.announce(STRINGS['text.announce.buttonRemoved']);
  };

  return (
    <div
      ref={root}
      role="dialog"
      aria-label={STRINGS['text.buttonPopover.label']}
      className="pk-link-popover"
      data-button-popover=""
      data-side={placement.side}
      style={{
        left: placement.left,
        top: placement.top,
        maxHeight: placement.maxHeight,
        transform: placement.side === 'above' ? 'translateY(-100%)' : undefined,
      }}
    >
      <div className="flex shrink-0 flex-col gap-1">
        <label htmlFor={labelId} className="text-body font-semibold text-text">
          {STRINGS['text.cta.labelField']}
        </label>
        <input
          ref={labelInput}
          id={labelId}
          type="text"
          autoComplete="off"
          value={label}
          maxLength={CTA_LABEL_MAX_LENGTH}
          data-button-label=""
          aria-invalid={empty}
          aria-describedby={empty ? noteId : undefined}
          className={LINK_INPUT}
          onChange={(event) => {
            // Cut to the cap even when the browser let more through.
            const next = event.target.value.slice(0, CTA_LABEL_MAX_LENGTH);
            setLabel(next);
            editor.commands.updateCta({ label: next });
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            event.stopPropagation();
            done();
          }}
        />
        {empty ? (
          <p
            id={noteId}
            role="alert"
            className="m-0 text-caption text-destructive"
          >
            {STRINGS['text.cta.labelError']}
          </p>
        ) : null}
      </div>
      {variants.length > SEGMENTED_MAX ? (
        <div className="flex shrink-0 flex-col gap-1">
          <label
            htmlFor={styleId}
            className="text-body font-semibold text-text"
          >
            {STRINGS['text.cta.style']}
          </label>
          <select
            id={styleId}
            value={variant}
            className={LINK_INPUT}
            onChange={(event) => {
              choose(event.target.value);
            }}
          >
            {variants.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div
          role="radiogroup"
          aria-label={STRINGS['text.cta.style']}
          className="flex shrink-0 gap-1 rounded-lg border border-border p-0.5"
          onKeyDown={onSegmentKeys}
        >
          {variants.map((entry) => (
            <button
              key={entry.value}
              type="button"
              role="radio"
              aria-checked={entry.value === variant}
              tabIndex={entry.value === variant ? 0 : -1}
              data-variant={entry.value}
              className={SEGMENT}
              onClick={() => {
                choose(entry.value);
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}
      <LinkTargetEditor
        value={target}
        locale={locale}
        focusOnOpen={false}
        {...(search === undefined ? {} : { search })}
        onChange={(next) => {
          editor.commands.updateCta({
            href: next.href,
            pageId: next.pageId,
            target: next.target,
          });
        }}
        onSubmit={done}
      />
      {empty || target === null ? (
        <p
          role="status"
          data-button-needs=""
          className="m-0 shrink-0 text-caption text-text-muted"
        >
          {empty
            ? STRINGS['text.cta.needsLabel']
            : STRINGS['text.cta.needsLink']}
        </p>
      ) : null}
      <div className="flex shrink-0 gap-2 pt-2">
        <button
          type="button"
          className={`${POPOVER_BUTTON} border-control-border bg-surface text-text hover:bg-surface-muted`}
          onClick={remove}
        >
          {STRINGS['text.cta.remove']}
        </button>
        <button
          type="button"
          className={`${POPOVER_BUTTON} border-transparent bg-accent text-accent-contrast`}
          onClick={done}
        >
          {STRINGS['text.cta.done']}
        </button>
      </div>
    </div>
  );
}
