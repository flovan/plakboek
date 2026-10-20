import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import type { Editor } from '@tiptap/core';
import {
  linkTargetSchema,
  type LinkTarget,
  type TextTheme,
} from '@plakboek/content/rich-text';
import type { Box } from '../../../client/overlay/geometry.js';
import { slashPlacement } from '../../../client/overlay/slot-geometry.js';
import { controlFor } from '../../../client/session/control-map.js';
import type { EditorStore } from '../../../client/session/store.js';
import type { TextController } from '../../../client/text/controller.js';
import type { FieldTarget } from '../../../client/text/field-target.js';
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

type ButtonPopoverCommon = {
  readonly controller: TextController;
  readonly store: EditorStore;
  /** The part of the document the frame shows, in the framed document's coordinates. */
  readonly visible: Box;
  /** The locale of the page being edited: the pages a button may point at. */
  readonly locale: string;
  /** Finds pages for the picker; without it only web addresses can be linked. */
  readonly search?: PageSearch;
};

/** The popover of a button typed into a text: it follows the selected CTA of the running editor. */
export type TextButtonPopoverProps = ButtonPopoverCommon & {
  readonly mode?: 'text';
  /** The property's theme: the variants a button can take. */
  readonly theme: TextTheme;
};

/** The popover of a button block: it edits the block's link, label and style properties. */
export type BlockButtonPopoverProps = ButtonPopoverCommon & {
  readonly mode: 'block';
  /** The block's link field. */
  readonly target: FieldTarget;
  /** The link field's box in the framed document's coordinates: where the popover hangs. */
  readonly anchor: Box;
};

export type ButtonPopoverProps =
  | TextButtonPopoverProps
  | BlockButtonPopoverProps;

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

type Variant = { readonly value: string; readonly label: string };

/** What the popover shows and does, whichever kind of button it edits. */
type PopoverModel = {
  /** The button's box in the framed document's coordinates. */
  readonly anchor: Box;
  /** The label when the popover opens; the field keeps what is typed after that. */
  readonly label: string;
  /** False when the button has no label of its own to edit (a link field with no label property). */
  readonly hasLabel: boolean;
  readonly labelMax: number;
  readonly variants: readonly Variant[];
  readonly variant: string;
  readonly target: LinkTarget | null;
  readonly onLabel: (label: string) => void;
  readonly onVariant: (variant: string) => void;
  readonly onTarget: (target: LinkTarget) => void;
  readonly onDone: () => void;
  /** Absent for a button block: the block's own Delete removes it. */
  readonly onRemove?: () => void;
  /** Escape, wherever the focus is. */
  readonly onEscape: () => void;
  /** A press outside the popover; `hadFocus` says the focus was inside it. */
  readonly onOutside: (event: Event, hadFocus: boolean) => void;
};

/**
 * The popover itself: a 320px non-modal dialog hung below the button (above it
 * when there is more room there, 8px inside the frame). It is the same for a
 * button in a text and a button block; what differs is where each edit goes,
 * which the model says.
 */
function PopoverView(props: {
  readonly model: PopoverModel;
  readonly visible: Box;
  readonly locale: string;
  readonly search: PageSearch | undefined;
}): ReactElement {
  const { model, visible, locale, search } = props;
  const root = useRef<HTMLDivElement>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const noteId = useId();
  const styleId = useId();
  const [label, setLabel] = useState(model.label);
  const { variants, variant, target } = model;

  // The label is ready to be replaced: focused, its text selected.
  useEffect(() => {
    labelInput.current?.focus();
    labelInput.current?.select();
  }, []);

  // Escape closes the popover and nothing else, wherever the focus is; a press
  // anywhere but here closes it as well.
  const latest = useRef(model);
  latest.current = model;
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
      latest.current.onEscape();
    };
    const onPress = (event: Event): void => {
      if (event.composedPath().includes(element)) return;
      // (inside a shadow root the focused element is that root's, not the document's)
      const rootNode = element.getRootNode() as Document | ShadowRoot;
      latest.current.onOutside(event, element.contains(rootNode.activeElement));
    };
    owner.addEventListener('keydown', onKey, true);
    owner.addEventListener('pointerdown', onPress, true);
    return () => {
      owner.removeEventListener('keydown', onKey, true);
      owner.removeEventListener('pointerdown', onPress, true);
    };
  }, []);

  const placement = slashPlacement(model.anchor, visible, POPOVER_MAX_HEIGHT);
  const empty = model.hasLabel && label.trim() === '';

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
    model.onVariant(next.value);
    // The newly selected radio is the one tab stop; focus follows the selection.
    const group = event.currentTarget;
    requestAnimationFrame(() => {
      group
        .querySelector<HTMLElement>(`[data-variant="${next.value}"]`)
        ?.focus();
    });
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
      {model.hasLabel ? (
        <div className="flex shrink-0 flex-col gap-1">
          <label
            htmlFor={labelId}
            className="text-body font-semibold text-text"
          >
            {STRINGS['text.cta.labelField']}
          </label>
          <input
            ref={labelInput}
            id={labelId}
            type="text"
            autoComplete="off"
            value={label}
            maxLength={model.labelMax}
            data-button-label=""
            aria-invalid={empty}
            aria-describedby={empty ? noteId : undefined}
            className={LINK_INPUT}
            onChange={(event) => {
              // Cut to the cap even when the browser let more through.
              const next = event.target.value.slice(0, model.labelMax);
              setLabel(next);
              model.onLabel(next);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              event.stopPropagation();
              model.onDone();
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
      ) : null}
      {variants.length === 0 ? null : variants.length > SEGMENTED_MAX ? (
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
              model.onVariant(event.target.value);
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
                model.onVariant(entry.value);
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
        focusOnOpen={!model.hasLabel}
        {...(search === undefined ? {} : { search })}
        onChange={(next) => {
          model.onTarget(next);
        }}
        onSubmit={model.onDone}
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
        {model.onRemove === undefined ? null : (
          <button
            type="button"
            className={`${POPOVER_BUTTON} border-control-border bg-surface text-text hover:bg-surface-muted`}
            onClick={model.onRemove}
          >
            {STRINGS['text.cta.remove']}
          </button>
        )}
        <button
          type="button"
          className={`${POPOVER_BUTTON} border-transparent bg-accent text-accent-contrast`}
          onClick={model.onDone}
        >
          {STRINGS['text.cta.done']}
        </button>
      </div>
    </div>
  );
}

/**
 * The Button popover of a button typed into a text. Everything is applied as
 * it is edited: the label, the variant and the link target go straight onto
 * the node, so the CTA in the field and the stored document follow. Remove
 * button deletes the node (Control+Z brings it back) and Done puts the caret
 * on the line below. Escape and a press anywhere else only close the popover.
 */
function TextButtonPopover(props: TextButtonPopoverProps): ReactElement | null {
  const { controller, store, theme, visible, locale, search } = props;
  const editor = controller.editor();
  const selected = editor === null ? null : selectedCta(editor.state);
  if (editor === null || selected === null) return null;
  const anchor = ctaBox(editor, selected.pos);
  if (anchor === null) return null;

  const attrs: Readonly<Record<string, unknown>> = selected.node.attrs;
  const variants = theme.ctaVariants;
  // A variant the theme no longer lists shows as the first one, so a radio is always checked.
  const stored = attrs['variant'];
  const variant = variants.some((entry) => entry.value === stored)
    ? (stored as string)
    : (variants[0]?.value ?? '');
  const labelValue: unknown = attrs['label'];

  const close = (): void => {
    controller.closeButton();
    controller.focusField();
  };

  const model: PopoverModel = {
    anchor,
    label: typeof labelValue === 'string' ? labelValue : '',
    hasLabel: true,
    labelMax: CTA_LABEL_MAX_LENGTH,
    variants,
    variant,
    target: ctaTargetOf(attrs),
    onLabel: (label) => {
      editor.commands.updateCta({ label });
    },
    onVariant: (next) => {
      editor.commands.updateCta({ variant: next });
    },
    onTarget: (next) => {
      editor.commands.updateCta({
        href: next.href,
        pageId: next.pageId,
        target: next.target,
      });
    },
    onDone: () => {
      const tr = caretAfterCta(editor.state);
      if (tr !== null) editor.view.dispatch(tr);
      close();
    },
    onRemove: () => {
      const tr = removeCta(editor.state);
      if (tr === null) return;
      editor.view.dispatch(tr);
      close();
      store.announce(STRINGS['text.announce.buttonRemoved']);
    },
    onEscape: close,
    // A press on a control that keeps the field's focus must not leave the
    // focus on the label that is about to disappear.
    onOutside: (_event, hadFocus) => {
      controller.closeButton();
      if (hadFocus) controller.focusField();
    },
  };
  return (
    <PopoverView
      model={model}
      visible={visible}
      locale={locale}
      search={search}
    />
  );
}

/** What a button block's properties hold when its popover opens. */
type BlockButtonStart = {
  readonly label: string;
  readonly labelMax: number;
  readonly variants: readonly Variant[];
  readonly variant: string;
  readonly target: LinkTarget | null;
};

function maxLengthOf(options: unknown): number | undefined {
  if (typeof options !== 'object' || options === null) return undefined;
  const value: unknown = Reflect.get(options, 'maxLength');
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : undefined;
}

function blockButtonStart(
  store: EditorStore,
  target: FieldTarget,
): BlockButtonStart {
  const { model, session } = store.getState();
  const node = model?.get(target.blockId);
  const props: Readonly<Record<string, unknown>> = node?.props ?? {};
  const properties =
    session?.catalogue.find((entry) => entry.key === node?.type)?.properties ??
    [];
  const labelProperty = properties.find((item) => item.key === target.labelKey);
  const variantProperty = properties.find(
    (item) => item.key === target.variantKey,
  );
  const stored = target.labelKey === undefined ? '' : props[target.labelKey];
  const variants: readonly Variant[] =
    variantProperty === undefined ? [] : controlFor(variantProperty).choices;
  const storedVariant =
    target.variantKey === undefined ? undefined : props[target.variantKey];
  const fallback: unknown = variantProperty?.defaultValue;
  const variant = [storedVariant, fallback].find(
    (candidate): candidate is string =>
      typeof candidate === 'string' &&
      variants.some((entry) => entry.value === candidate),
  );
  const parsed = linkTargetSchema.safeParse(props[target.key]);
  const link = parsed.success ? parsed.data : null;
  return {
    label: typeof stored === 'string' ? stored : '',
    labelMax: maxLengthOf(labelProperty?.options) ?? CTA_LABEL_MAX_LENGTH,
    variants,
    variant: variant ?? variants[0]?.value ?? '',
    target:
      link !== null && (link.href !== null || link.pageId !== null)
        ? link
        : null,
  };
}

/**
 * The Button popover of a button block: the same dialog, over the block's own
 * properties. Label, Style and Link are written through the normal property
 * preview and save, so the block renders live and an undo takes one property
 * burst back. There is no Remove button (the block's Delete does that), and
 * Done or Escape ends the session with the block selected.
 */
function BlockButtonPopover(
  props: BlockButtonPopoverProps,
): ReactElement | null {
  const { controller, store, target, anchor, visible, locale, search } = props;
  const [start] = useState(() => blockButtonStart(store, target));
  const [variant, setVariant] = useState(start.variant);
  const [link, setLink] = useState(start.target);

  const model: PopoverModel = {
    anchor,
    label: start.label,
    hasLabel: target.labelKey !== undefined,
    labelMax: start.labelMax,
    variants: start.variants,
    variant,
    target: link,
    onLabel: (label) => {
      if (target.labelKey === undefined) return;
      // Typing waits for a pause before it is saved, like text on the page.
      controller.setBlockProperty(
        target.labelKey,
        label === '' ? undefined : label,
        false,
      );
    },
    onVariant: (next) => {
      if (target.variantKey === undefined) return;
      setVariant(next);
      controller.setBlockProperty(target.variantKey, next, true);
    },
    onTarget: (next) => {
      setLink(next);
      controller.setBlockProperty(target.key, next, true);
    },
    onDone: () => {
      void controller.exit('done');
    },
    onEscape: () => {
      void controller.exit('escape');
    },
    onOutside: (event) => {
      // A press on the button itself is the click that opens this popover again.
      if (event.composedPath().includes(target.element)) return;
      void controller.exit('click');
    },
  };
  return (
    <PopoverView
      model={model}
      visible={visible}
      locale={locale}
      search={search}
    />
  );
}

/**
 * The Button popover: for a button typed into a text (`mode` 'text', the
 * default) it follows the selected CTA of the running editor; for a button
 * block (`mode` 'block') it edits the block's link, label and style
 * properties.
 */
export function ButtonPopover(props: ButtonPopoverProps): ReactElement | null {
  return props.mode === 'block' ? (
    <BlockButtonPopover {...props} />
  ) : (
    <TextButtonPopover {...props} />
  );
}
