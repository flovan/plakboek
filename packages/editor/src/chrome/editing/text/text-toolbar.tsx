import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import type { Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import type { TextTheme } from '@plakboek/content/rich-text';
import {
  fieldBarPlacement,
  type Box,
} from '../../../client/overlay/geometry.js';
import type { EditorStore } from '../../../client/session/store.js';
import type { TextController } from '../../../client/text/controller.js';
import {
  insertItems,
  type InsertItem,
} from '../../../client/text/insert-items.js';
import {
  BoldIcon,
  CheckIcon,
  ItalicIcon,
  LinkIcon,
  ListBulletIcon,
  ListNumberedIcon,
  PaletteIcon,
  StrikethroughIcon,
  UnderlineIcon,
} from '../../icons.js';
import { formatString, STRINGS, type StringKey } from '../../strings.js';
import { Tooltip } from '../../tooltip.js';
import { useRoving } from './crumbs.js';
import { CustomStyleRow } from './custom-style-row.js';
import { boxStyle, DONE_BUTTON } from './field-bar.js';
import { hasCustomStyle } from '../../../client/text/commands.js';
import {
  ariaShortcut,
  currentPlatform,
  shortcutLabel,
  type ShortcutId,
} from './shortcuts.js';
import { InsertMenu } from './insert-menu.js';
import { LinkPopover } from './link-popover.js';
import { MoreMenu, type MoreEntry } from './more-menu.js';
import type { PageSearch } from './page-picker.js';
import { StyleMenu } from './style-menu.js';
import {
  collapseToolbar,
  CONTROL_GROUPS,
  type Collapse,
  type ControlId,
  type GroupedControlId,
} from './toolbar-overflow.js';
import {
  STYLE_LEVEL,
  toolbarChanges,
  toolbarModel,
  type StyleId,
  type ToggleControl,
  type CustomStyleControl,
  type ToolbarModel,
  type ToggleId,
} from './toolbar-state.js';

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
  /** Finds pages for the link popover's picker; without it links go to web addresses only. */
  readonly search?: PageSearch;
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
  italic: {
    name: 'text.mark.italic',
    Icon: ItalicIcon,
    run: (editor: Editor) => editor.chain().toggleItalic().run(),
  },
  underline: {
    name: 'text.mark.underline',
    Icon: UnderlineIcon,
    run: (editor: Editor) => editor.chain().toggleUnderline().run(),
  },
  strike: {
    name: 'text.mark.strike',
    Icon: StrikethroughIcon,
    run: (editor: Editor) => editor.chain().toggleStrike().run(),
  },
  bulletList: {
    name: 'text.list.bullet',
    Icon: ListBulletIcon,
    run: (editor: Editor) => editor.chain().toggleBulletList().run(),
  },
  orderedList: {
    name: 'text.list.ordered',
    Icon: ListNumberedIcon,
    run: (editor: Editor) => editor.chain().toggleOrderedList().run(),
  },
} as const satisfies Record<
  ToggleId,
  {
    name: StringKey;
    Icon: typeof BoldIcon;
    run: (editor: Editor) => boolean;
  }
>;

const STYLE_NAME = {
  paragraph: 'text.style.paragraph',
  title: 'text.style.title',
  heading: 'text.style.heading',
  subheading: 'text.style.subheading',
} as const satisfies Record<StyleId, StringKey>;

/** The width of each control before it has been measured: the CSS gives them fixed sizes. */
const DEFAULT_WIDTH: Readonly<Record<ControlId, number>> = {
  style: 112,
  bold: 32,
  italic: 32,
  underline: 32,
  strike: 32,
  bulletList: 32,
  orderedList: 32,
  link: 32,
  insert: 32,
  customStyle: 118,
  done: 0,
};

const CONTROL_IDS: ReadonlySet<string> = new Set<string>([
  ...CONTROL_GROUPS.flat(),
  'customStyle',
  'done',
]);

/** The controls of the Custom style row, in the order the keyboard visits them. */
const CUSTOM_ROW_KEYS = [
  'size',
  'color',
  'align-left',
  'align-center',
  'align-right',
  'reset',
] as const;

/** A 32px toggle with its text: Custom style. Pressed it takes the inverted fill. */
const CUSTOM_TOGGLE =
  'relative flex h-8 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-2 text-body font-semibold text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring aria-pressed:bg-text aria-pressed:text-surface aria-pressed:hover:bg-text';

type Measured = {
  readonly widths: Readonly<Partial<Record<ControlId, number>>>;
  /** How wide Done's text is, once it has been on show. */
  readonly doneText: number;
};

/** Whether a control of the Custom style row is drawn for what the theme declares. */
function customRowKeyShown(
  key: (typeof CUSTOM_ROW_KEYS)[number],
  control: CustomStyleControl | null,
): boolean {
  if (control === null) return false;
  if (key === 'size') return control.sizes.length > 0;
  if (key === 'color') return control.colors.length > 0;
  if (key === 'reset') return true;
  return control.align;
}

function Divider(): ReactElement {
  return <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />;
}

/**
 * The floating toolbar of the rich text field being edited. It replaces the
 * block toolbar and is placed by the field (above it, below when there is no
 * room, pinned inside a field taller than the frame); it follows the field,
 * never the caret, so it stays put while the selection moves inside it. Its
 * buttons keep the field's focus and selection: a press does not move focus.
 * What it offers is the property's effective theme, nothing else.
 */
export function TextToolbar(props: TextToolbarProps): ReactElement | null {
  const { controller, store, label, theme, field, visible, search } = props;
  const root = useRef<HTMLDivElement>(null);
  const doneText = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState({ width: 0, height: 40 });
  // The Custom style row: closed by default, open for the rest of the field
  // session once the toggle is pressed.
  const [customOpen, setCustomOpen] = useState(false);
  const customRowId = useId();
  const customActiveId = useId();
  const [measured, setMeasured] = useState<Measured>({
    widths: {},
    doneText: 0,
  });

  // Every transaction gives a new editor state, which redraws the toolbar.
  const state = useSyncExternalStore(
    controller.subscribe,
    () => controller.editor()?.state ?? null,
  );

  // The link popover is asked for by the Link button, Mod-K and a click on a
  // link; the number changes with each request so a repeat starts afresh.
  const linkRequest = useSyncExternalStore(controller.subscribe, () =>
    controller.linkRequest(),
  );

  const model = toolbarModel({
    theme,
    isActive: (name, attributes) =>
      controller.editor()?.isActive(name, attributes) ?? false,
  });
  const plusItems = model.insert ? insertItems(theme, 'plus') : [];

  // What the frame leaves the bar: its width minus 16px. Controls that do not
  // fit collapse in a fixed order (Done to its icon, then toggles into More).
  const available = Math.max(0, visible.width - 16);
  const present: GroupedControlId[] = [
    ...(model.style === null ? [] : (['style'] as const)),
    ...model.marks.map((toggle) => toggle.id),
    ...model.lists.map((toggle) => toggle.id),
    ...(model.link === null ? [] : (['link'] as const)),
    ...(plusItems.length === 0 ? [] : (['insert'] as const)),
  ];
  // Until Done's text has been on show and measured, nothing collapses: the
  // first pass draws the bar whole so that it can be measured.
  const collapse: Collapse =
    measured.doneText === 0
      ? { visible: present, inMore: [], doneIconOnly: false }
      : collapseToolbar({
          widths: Object.fromEntries(
            [
              ...present,
              ...(model.customStyle === null ? [] : ['customStyle' as const]),
              'done' as const,
            ].map((id) => [id, measured.widths[id] ?? DEFAULT_WIDTH[id]]),
          ),
          available,
          doneTextWidth: measured.doneText,
        });
  const moved = new Set<string>(collapse.inMore);

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
    // Each control is measured while it is on the bar; one that has moved
    // keeps the width it had. Done's text is measured while it is shown.
    const widths: Partial<Record<ControlId, number>> = {
      ...measured.widths,
    };
    let changed = false;
    for (const control of element.querySelectorAll<HTMLElement>(
      '[data-roving]',
    )) {
      const id = control.dataset['roving'] ?? '';
      if (!CONTROL_IDS.has(id) || (id === 'done' && collapse.doneIconOnly)) {
        continue;
      }
      const measuredWidth = control.offsetWidth;
      if (measuredWidth > 0 && widths[id as ControlId] !== measuredWidth) {
        widths[id as ControlId] = measuredWidth;
        changed = true;
      }
    }
    const textWidth = doneText.current?.offsetWidth ?? 0;
    const text = textWidth > 0 ? textWidth : measured.doneText;
    if (changed || text !== measured.doneText) {
      setMeasured({ widths, doneText: text });
    }
  });

  const keys = [
    ...(model.style === null ? [] : ['style']),
    ...model.marks
      .filter((toggle) => !moved.has(toggle.id))
      .map((toggle) => toggle.id),
    ...model.lists
      .filter((toggle) => !moved.has(toggle.id))
      .map((toggle) => toggle.id),
    ...(model.link === null ? [] : ['link']),
    ...(plusItems.length === 0 ? [] : ['insert']),
    ...(model.customStyle === null ? [] : ['customStyle']),
    ...(collapse.inMore.length === 0 ? [] : ['more']),
    'done',
    ...(customOpen && model.customStyle !== null
      ? CUSTOM_ROW_KEYS.filter((key) =>
          customRowKeyShown(key, model.customStyle),
        )
      : []),
  ];
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

  // What a change did is announced from the editor's state, so a button, a
  // shortcut and anything else that edits the field are heard alike. A caret
  // moving into formatted text is not a change: only an edit, or a mark
  // toggled at a caret, is.
  const last = useRef<{
    readonly state: EditorState;
    readonly model: ToolbarModel;
  } | null>(null);
  useEffect(() => {
    const before = last.current;
    last.current = state === null ? null : { state, model };
    if (before === null || state === null) return;
    const edited =
      before.state.doc !== state.doc ||
      (before.state.selection.eq(state.selection) &&
        before.state.storedMarks !== state.storedMarks);
    if (!edited) return;
    const heard = toolbarChanges(before.model, model).map((change) =>
      change.kind === 'style'
        ? formatString('text.announce.style', {
            style: STRINGS[STYLE_NAME[change.style]],
          })
        : formatString(change.on ? 'text.announce.on' : 'text.announce.off', {
            name: STRINGS[TOGGLES[change.id].name],
          }),
    );
    if (heard.length > 0) store.announce(heard.join(' '));
  });

  if (state === null) return null;
  const customized = model.customStyle !== null && hasCustomStyle(state);

  const toggle = (id: ToggleId): void => {
    const editor = controller.editor();
    if (editor === null) return;
    TOGGLES[id].run(editor);
  };

  const chooseStyle = (style: StyleId): void => {
    const editor = controller.editor();
    if (editor === null) return;
    if (style === 'paragraph') editor.chain().setParagraph().run();
    else editor.chain().setHeading({ level: STYLE_LEVEL[style] }).run();
    store.announce(
      formatString('text.announce.style', {
        style: STRINGS[STYLE_NAME[style]],
      }),
    );
  };

  const insert = (item: InsertItem): void => {
    const editor = controller.editor();
    if (editor === null) return;
    item.run(editor.chain().focus()).run();
    store.announce(
      formatString('text.announce.inserted', { item: item.label }),
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
  const maxWidth = available;
  const tooltipSide = placement.mode === 'below' ? 'top' : 'bottom';
  const platform = currentPlatform();

  const toggleButton = (control: ToggleControl): ReactElement => {
    const { name, Icon } = TOGGLES[control.id];
    const shortcut: ShortcutId = control.id;
    return (
      <Tooltip
        key={control.id}
        label={formatString('text.withShortcut', {
          name: STRINGS[name],
          shortcut: shortcutLabel(shortcut, platform),
        })}
        placement={tooltipSide}
      >
        <button
          type="button"
          className={TOGGLE}
          aria-label={STRINGS[name]}
          aria-pressed={control.pressed}
          aria-keyshortcuts={ariaShortcut(shortcut, platform)}
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
  };

  const linkButton =
    model.link === null ? null : (
      <Tooltip
        label={formatString('text.withShortcut', {
          name: STRINGS['text.link'],
          shortcut: shortcutLabel('link', platform),
        })}
        placement={tooltipSide}
      >
        <button
          type="button"
          className={TOGGLE}
          aria-label={STRINGS['text.link']}
          aria-pressed={model.link.pressed}
          aria-haspopup="dialog"
          aria-expanded={linkRequest !== 0}
          aria-keyshortcuts={ariaShortcut('link', platform)}
          data-link-button=""
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            controller.openLink();
          }}
          {...rove('link')}
        >
          <LinkIcon />
        </button>
      </Tooltip>
    );

  const shownMarks = model.marks.filter((toggle) => !moved.has(toggle.id));
  const shownLists = model.lists.filter((toggle) => !moved.has(toggle.id));
  const moreEntries: readonly MoreEntry[] = [...model.marks, ...model.lists]
    .filter((control) => moved.has(control.id))
    .map((control) => {
      const { name, Icon } = TOGGLES[control.id];
      return {
        id: control.id,
        name: STRINGS[name],
        icon: <Icon />,
        pressed: control.pressed,
        run: () => {
          toggle(control.id);
        },
      };
    });

  // The groups the theme leaves non-empty, in the toolbar's order.
  const groups: { readonly key: string; readonly node: ReactElement }[] = [
    ...(model.style === null
      ? []
      : [
          {
            key: 'style',
            node: (
              <StyleMenu
                current={model.style.current}
                options={model.style.options}
                onChoose={chooseStyle}
                onReturn={() => {
                  controller.focusField();
                }}
                rove={rove}
                platform={platform}
                tooltipSide={tooltipSide}
              />
            ),
          },
        ]),
    ...(shownMarks.length === 0
      ? []
      : [
          {
            key: 'marks',
            node: <>{shownMarks.map(toggleButton)}</>,
          },
        ]),
    ...(shownLists.length === 0
      ? []
      : [
          {
            key: 'lists',
            node: <>{shownLists.map(toggleButton)}</>,
          },
        ]),
    ...(linkButton === null ? [] : [{ key: 'link', node: linkButton }]),
    ...(plusItems.length === 0
      ? []
      : [
          {
            key: 'insert',
            node: (
              <InsertMenu
                items={plusItems}
                onChoose={insert}
                onReturn={() => {
                  controller.focusField();
                }}
                rove={rove}
                tooltipSide={tooltipSide}
              />
            ),
          },
        ]),
  ];
  const customToggle =
    model.customStyle === null ? null : (
      <>
        <Tooltip
          label={STRINGS['text.customStyle.tooltip']}
          placement={tooltipSide}
        >
          <button
            type="button"
            className={CUSTOM_TOGGLE}
            aria-pressed={customOpen}
            aria-expanded={customOpen}
            aria-controls={customRowId}
            aria-describedby={customized ? customActiveId : undefined}
            data-custom-toggle=""
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              setCustomOpen(!customOpen);
            }}
            {...rove('customStyle')}
          >
            <PaletteIcon />
            {STRINGS['text.customStyle']}
            {customized ? (
              <span
                aria-hidden="true"
                data-custom-dot=""
                className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-text ring-2 ring-surface"
              />
            ) : null}
          </button>
        </Tooltip>
        {customized ? (
          <span id={customActiveId} className="sr-only">
            {STRINGS['text.customStyle.active']}
          </span>
        ) : null}
      </>
    );

  // The second row opens on the side of the bar away from the field, so the
  // main row never moves relative to the field.
  const customRow =
    customOpen && model.customStyle !== null ? (
      <CustomStyleRow
        id={customRowId}
        controller={controller}
        store={store}
        control={model.customStyle}
        state={state}
        rove={rove}
        tooltipSide={tooltipSide}
      />
    ) : null;
  const rowFirst = placement.mode === 'above';

  return (
    <>
      {/* The wrapper is always there so the bar keeps its place in the tree when
        it changes side. Pinned, it spans the field and the bar sticks inside it. */}
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
          data-rows={customRow === null ? '1' : '2'}
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
          {rowFirst ? customRow : null}
          <div className="pk-toolbar-row" data-main-row="">
            {groups.map((group, at) => (
              <Fragment key={group.key}>
                {at === 0 ? null : <Divider />}
                {group.node}
              </Fragment>
            ))}
            {groups.length === 0 ? null : <Divider />}
            {customToggle}
            <MoreMenu
              entries={moreEntries}
              onReturn={() => {
                controller.focusField();
              }}
              rove={rove}
              tooltipSide={tooltipSide}
            />
            <Tooltip
              label={STRINGS['text.done.tooltip']}
              placement={tooltipSide}
            >
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
                {collapse.doneIconOnly ? null : (
                  <span ref={doneText}>{STRINGS['text.done']}</span>
                )}
              </button>
            </Tooltip>
          </div>
          {rowFirst ? null : customRow}
        </div>
      </div>
      {linkRequest !== 0 && model.link !== null ? (
        <LinkPopover
          key={linkRequest}
          controller={controller}
          store={store}
          visible={visible}
          locale={store.getState().session?.locale ?? ''}
          {...(search === undefined ? {} : { search })}
        />
      ) : null}
    </>
  );
}
