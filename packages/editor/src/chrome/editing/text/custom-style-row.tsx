import type { ReactElement } from 'react';
import type { EditorState } from '@tiptap/pm/state';
import type { Command } from '@tiptap/pm/state';
import type { TextAlign } from '@plakboek/content/rich-text';
import {
  clearTextColor,
  clearTextSize,
  currentCustomStyle,
  hasCustomStyle,
  resetStyle,
  setTextAlign,
  setTextColor,
  setTextSize,
} from '../../../client/text/commands.js';
import type { TextController } from '../../../client/text/controller.js';
import type { EditorStore } from '../../../client/session/store.js';
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  ResetIcon,
} from '../../icons.js';
import { formatString, STRINGS, type StringKey } from '../../strings.js';
import { Tooltip } from '../../tooltip.js';
import { currentPlatform } from './shortcuts.js';
import { ColorPopover } from './color-popover.js';
import type { Rove } from './crumbs.js';
import { SizePopover } from './size-popover.js';
import { choiceLabel, type CustomStyleControl } from './toolbar-state.js';

export type CustomStyleRowProps = {
  readonly id: string;
  readonly controller: TextController;
  readonly store: EditorStore;
  readonly control: CustomStyleControl;
  /** The editor's state, so the row follows the selection. */
  readonly state: EditorState;
  readonly rove: Rove;
  readonly tooltipSide: 'top' | 'bottom';
};

const ALIGNS = [
  { align: 'left', Icon: AlignLeftIcon, name: 'text.align.left' },
  { align: 'center', Icon: AlignCenterIcon, name: 'text.align.center' },
  { align: 'right', Icon: AlignRightIcon, name: 'text.align.right' },
] as const satisfies readonly {
  align: TextAlign;
  Icon: typeof AlignLeftIcon;
  name: StringKey;
}[];

const ALIGN_NAME = {
  left: 'text.alignName.left',
  center: 'text.alignName.center',
  right: 'text.alignName.right',
} as const satisfies Record<TextAlign, StringKey>;

const ALIGN_BUTTON =
  'flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring aria-pressed:bg-text aria-pressed:text-surface aria-pressed:hover:bg-text';

const RESET_BUTTON =
  'flex h-8 cursor-pointer items-center gap-1 rounded-md border border-border bg-transparent px-2 text-body font-semibold text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring aria-disabled:cursor-default aria-disabled:text-text-muted aria-disabled:hover:bg-transparent';

function literalSize(value: string): string {
  return formatString('text.size.value', {
    n: String(Number.parseInt(value, 10)),
  });
}

/**
 * The second row of the text toolbar: Size, Color and Alignment for the
 * selection, and Reset style. It shows only what the theme declares, and
 * every change goes through the 09-23 commands on the live editor. Its
 * buttons keep the field's focus; a press never moves the caret.
 */
export function CustomStyleRow(props: CustomStyleRowProps): ReactElement {
  const { id, controller, store, control, state, rove, tooltipSide } = props;
  const current = currentCustomStyle(state);
  const customized = hasCustomStyle(state);

  const run = (command: Command): boolean => {
    const editor = controller.editor();
    if (editor === null) return false;
    const { view } = editor;
    return command(view.state, (tr) => {
      view.dispatch(tr);
    });
  };
  const back = (): void => {
    controller.focusField();
  };

  const colorLabel = choiceLabel(
    control.colors,
    current.color,
    (value) => value,
  );
  const sizeLabel =
    choiceLabel(control.sizes, current.size, literalSize) ??
    STRINGS['text.themeDefault'];

  return (
    <div
      id={id}
      className="pk-toolbar-row"
      data-custom-row=""
      role="group"
      aria-label={STRINGS['text.customStyle']}
    >
      {control.sizes.length === 0 ? null : (
        <SizePopover
          entries={control.sizes}
          allowCustomValues={control.allowCustomValues}
          current={current.size}
          currentLabel={sizeLabel}
          rove={rove}
          tooltipSide={tooltipSide}
          onReturn={back}
          onChoose={(choice, label) => {
            const done =
              choice === null ? run(clearTextSize) : run(setTextSize(choice));
            if (done) {
              store.announce(formatString('text.announce.sizeSet', { label }));
            }
          }}
        />
      )}
      {control.colors.length === 0 ? null : (
        <ColorPopover
          entries={control.colors}
          allowCustomValues={control.allowCustomValues}
          current={current.color}
          currentLabel={colorLabel}
          rove={rove}
          tooltipSide={tooltipSide}
          onReturn={back}
          onChoose={(choice, label) => {
            const done =
              choice === null ? run(clearTextColor) : run(setTextColor(choice));
            if (done) {
              store.announce(formatString('text.announce.colorSet', { label }));
            }
          }}
        />
      )}
      {control.align ? (
        <div
          role="group"
          aria-label={STRINGS['text.align.label']}
          className="flex items-center gap-1"
        >
          {ALIGNS.map(({ align, Icon, name }) => (
            <Tooltip key={align} label={STRINGS[name]} placement={tooltipSide}>
              <button
                type="button"
                className={ALIGN_BUTTON}
                aria-label={STRINGS[name]}
                aria-pressed={current.align === align}
                data-align={align}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  if (!run(setTextAlign(align))) return;
                  const editor = controller.editor();
                  const now =
                    editor === null
                      ? null
                      : currentCustomStyle(editor.view.state).align;
                  store.announce(
                    formatString('text.announce.alignSet', {
                      align:
                        now === null
                          ? STRINGS['text.themeDefault']
                          : STRINGS[ALIGN_NAME[now]],
                    }),
                  );
                }}
                {...rove(`align-${align}`)}
              >
                <Icon />
              </button>
            </Tooltip>
          ))}
        </div>
      ) : null}
      <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
      <Tooltip
        label={
          customized ? STRINGS['text.reset'] : STRINGS['text.reset.disabled']
        }
        placement={tooltipSide}
      >
        <button
          type="button"
          className={RESET_BUTTON}
          aria-label={
            customized
              ? STRINGS['text.reset']
              : STRINGS['text.reset.disabledLabel']
          }
          aria-disabled={customized ? undefined : true}
          aria-keyshortcuts={`${currentPlatform() === 'mac' ? 'Meta' : 'Control'}+\\`}
          data-reset-style=""
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            if (!customized) return;
            if (run(resetStyle)) {
              store.announce(formatString('text.announce.styleReset'));
            }
          }}
          {...rove('reset')}
        >
          <ResetIcon />
          {STRINGS['text.reset']}
        </button>
      </Tooltip>
    </div>
  );
}
