import { createContext, useContext, useState, type ReactElement } from 'react';
import { linkTargetSchema } from '@plakboek/content/rich-text';
import { STRINGS } from '../../strings.js';
import { LinkTargetEditor } from '../text/link-target-editor.js';
import type { PageSearch } from '../text/page-picker.js';

/** What the link control needs of the page being edited: where pages are found and in which locale. */
export type LinkSearchValue = {
  readonly search: PageSearch | undefined;
  readonly locale: string;
};

/**
 * Given by the Properties panel, so a link control anywhere in it (a repeater's
 * sub-field included) finds pages without each field being handed the search.
 * Without one only a web address can be entered.
 */
export const LinkSearchContext = createContext<LinkSearchValue>({
  search: undefined,
  locale: '',
});

export type LinkControlProps = {
  readonly id: string;
  readonly labelId: string;
  readonly fieldKey: string;
  /** The stored `{ href, pageId, target }`, or anything else for a property with no link yet. */
  readonly value: unknown;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly required: boolean;
  /** A required value is empty: the border takes the attention colour. */
  readonly attention: boolean;
  readonly describedBy: string | undefined;
  /** Called with a complete, allowed target, or `undefined` when the link is removed. */
  readonly onChange: (value: unknown, immediate: boolean) => void;
  readonly onBlur: () => void;
};

function border(props: Pick<LinkControlProps, 'invalid' | 'attention'>) {
  if (props.invalid) return 'border-destructive';
  return props.attention ? 'border-attention' : 'border-control-border';
}

/**
 * The Properties control of a `link` property: the same Link target section
 * the link and button popovers use, drawn inline in the panel. A target is
 * written as soon as it is complete and allowed: a page picked and the new-tab
 * switch at once, a typed address after a pause (or on Enter). "Remove link"
 * clears it. The page list scrolls inside the control.
 */
export function LinkControl(props: LinkControlProps): ReactElement {
  const { id, labelId, fieldKey, disabled, onChange, onBlur } = props;
  const { search, locale } = useContext(LinkSearchContext);
  // Removing the link starts the section afresh: its address and switch are cleared too.
  const [round, setRound] = useState(0);
  const parsed = linkTargetSchema.safeParse(props.value);
  const target = parsed.success ? parsed.data : null;
  const present =
    target !== null && (target.href !== null || target.pageId !== null);

  return (
    <fieldset
      id={id}
      tabIndex={-1}
      disabled={disabled}
      data-control={fieldKey}
      data-link-control=""
      aria-labelledby={labelId}
      aria-describedby={props.describedBy}
      aria-invalid={props.invalid ? true : undefined}
      aria-required={props.required ? true : undefined}
      className={`m-0 box-border flex min-w-0 flex-col gap-3 rounded-lg border bg-input-fill p-3 ${border(props)}`}
      onBlur={onBlur}
    >
      <div className="flex max-h-[360px] min-h-0 flex-col gap-2">
        <LinkTargetEditor
          key={round}
          value={target}
          locale={locale}
          focusOnOpen={false}
          {...(search === undefined ? {} : { search })}
          onChange={(next, _title, source) => {
            // A pick is saved at once; a typed address waits for a pause.
            onChange(next, source === 'pick');
          }}
          onSubmit={(next) => {
            onChange(next, true);
          }}
        />
      </div>
      {present && !disabled ? (
        <button
          type="button"
          data-link-remove=""
          className="h-8 cursor-pointer self-start rounded-lg border border-control-border bg-surface px-3 text-caption font-semibold text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          onClick={() => {
            setRound((count) => count + 1);
            onChange(undefined, true);
          }}
        >
          {STRINGS['text.link.remove']}
        </button>
      ) : null}
    </fieldset>
  );
}
