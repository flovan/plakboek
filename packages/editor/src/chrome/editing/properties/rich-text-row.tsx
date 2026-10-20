import { createContext, useContext, type ReactElement } from 'react';
import { documentText } from '../../../client/text/plain-field.js';
import { EditPointerIcon } from '../../icons.js';
import { formatString, STRINGS } from '../../strings.js';

/**
 * How the Properties panel reaches the text on the page: whether the block
 * marks a property as a field the editor can type in, and how to start typing
 * in it. Without it (a repeater's sub-field, a panel with no page behind it)
 * a text property has no field to point at.
 */
export type TextFieldAccess = {
  /** The block whose properties are drawn. */
  readonly blockId: string;
  /** Whether the block marks the property as an editable field on the page. */
  readonly has: (key: string) => boolean;
  /** Selects the block, brings the field into view and puts the caret at its end. */
  readonly enter: (key: string) => void;
};

export const TextFieldContext = createContext<TextFieldAccess | null>(null);

const BUTTON =
  'box-border flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-control-border bg-surface px-3 text-body font-semibold text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

export type RichTextRowProps = {
  readonly id: string;
  readonly fieldKey: string;
  readonly label: string;
  readonly labelId: string;
  /** The stored document, or what was typed on the page since. */
  readonly value: unknown;
  /** A required value is empty: the border takes the attention colour. */
  readonly attention: boolean;
  readonly describedBy: string | undefined;
};

/**
 * A formatted text property in the Properties panel: a read-only preview of its
 * words, clamped to three lines, and a button that starts typing in the field
 * on the page. A property the block never marks as a field says so instead of
 * offering the button.
 */
export function RichTextRow(props: RichTextRowProps): ReactElement {
  const { id, fieldKey, label, labelId, value, attention, describedBy } = props;
  const access = useContext(TextFieldContext);
  const words = documentText(value);
  const editable = access?.has(fieldKey) === true;
  return (
    <div
      id={id}
      role="group"
      data-rich-text-row={fieldKey}
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      className="flex flex-col gap-2"
    >
      <div
        data-text-preview=""
        data-empty={words === '' ? '' : undefined}
        className={`box-border rounded-lg border bg-surface-muted px-3 py-2 text-body wrap-anywhere whitespace-pre-line line-clamp-3 ${
          attention ? 'border-attention' : 'border-border'
        } ${words === '' ? 'text-text-muted' : 'text-text'}`}
      >
        {words === '' ? STRINGS['text.panel.empty'] : words}
      </div>
      {editable && access !== null ? (
        <>
          <button
            type="button"
            data-control={fieldKey}
            data-edit-on-page=""
            aria-label={formatString('text.panel.editOnPage.label', { label })}
            className={BUTTON}
            onClick={() => {
              access.enter(fieldKey);
            }}
          >
            <EditPointerIcon />
            {STRINGS['text.panel.editOnPage']}
          </button>
          <p className="m-0 text-body text-text-muted wrap-anywhere">
            {STRINGS['text.panel.editOnPage.hint']}
          </p>
        </>
      ) : (
        <p
          data-not-editable=""
          className="m-0 text-body text-text-muted wrap-anywhere"
        >
          {STRINGS['text.panel.notEditable']}
        </p>
      )}
    </div>
  );
}
