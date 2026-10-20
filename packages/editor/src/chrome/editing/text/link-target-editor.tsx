import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { isAllowedHref, type LinkTarget } from '@plakboek/content/rich-text';
import { STRINGS } from '../../strings.js';

export type LinkTargetEditorProps = {
  /** The pending target: the stored one when editing, the last valid one while typing; null before any. */
  readonly value: LinkTarget | null;
  /**
   * Called with each target that is complete and allowed, as it is typed or
   * picked. An invalid address is not reported, so the owner keeps the last
   * valid target.
   */
  readonly onChange: (target: LinkTarget) => void;
  /** Enter in the address input with a valid address: the owner applies. */
  readonly onSubmit?: () => void;
};

/** A 40px text input of the link popover. */
export const LINK_INPUT =
  'box-border h-10 w-full min-w-0 rounded-md border border-border bg-surface px-2 text-body text-text focus-visible:outline-2 focus-visible:outline-focus-ring aria-invalid:border-destructive';

/** A 40px by 24px track; a checked one is filled with the text colour. */
const SWITCH =
  'relative h-6 w-10 shrink-0 cursor-pointer appearance-none rounded-full border border-control-border bg-surface-muted before:absolute before:top-0.5 before:left-0.5 before:size-[18px] before:rounded-full before:bg-text checked:bg-text checked:before:translate-x-4 checked:before:bg-surface focus-visible:outline-2 focus-visible:outline-focus-ring';

/**
 * The Link target section: where a link points and whether it opens in a new
 * tab. It is shared by the link popover and, in later plans, the button
 * popover and the Button block, so a target is picked the same way
 * everywhere. It edits a pending target and reports each valid one; it never
 * writes anything itself.
 */
export function LinkTargetEditor(props: LinkTargetEditorProps): ReactElement {
  const { value, onChange, onSubmit } = props;
  const [text, setText] = useState(value?.href ?? '');
  const [showError, setShowError] = useState(false);
  const [newTab, setNewTab] = useState(value?.target === '_blank');
  const inputId = useId();
  const noteId = useId();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const trimmed = text.trim();
  const valid = trimmed !== '' && isAllowedHref(trimmed);
  const invalid = showError && trimmed !== '' && !valid;
  const targetOf = (address: string, tab: boolean): LinkTarget => ({
    href: address,
    pageId: null,
    target: tab ? '_blank' : null,
  });

  return (
    <>
      <div className="flex flex-col gap-1">
        <label htmlFor={inputId} className="text-body font-semibold text-text">
          {STRINGS['text.web.label']}
        </label>
        <input
          ref={input}
          id={inputId}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={text}
          data-link-input="web"
          aria-invalid={invalid}
          aria-describedby={noteId}
          className={LINK_INPUT}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            const address = next.trim();
            if (address !== '' && isAllowedHref(address)) {
              setShowError(false);
              onChange(targetOf(address, newTab));
            }
          }}
          onBlur={() => {
            setShowError(true);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            event.stopPropagation();
            if (!valid) {
              setShowError(true);
              return;
            }
            onChange(targetOf(trimmed, newTab));
            onSubmit?.();
          }}
        />
        <p
          id={noteId}
          role={invalid ? 'alert' : undefined}
          className={`m-0 text-caption ${invalid ? 'text-destructive' : 'text-text-muted'}`}
        >
          {invalid ? STRINGS['text.web.error'] : STRINGS['text.web.hint']}
        </p>
      </div>
      <label className="flex h-10 items-center justify-between gap-2 text-body text-text">
        {STRINGS['text.newTab']}
        <input
          type="checkbox"
          role="switch"
          checked={newTab}
          data-link-new-tab=""
          className={SWITCH}
          onChange={(event) => {
            const tab = event.target.checked;
            setNewTab(tab);
            if (value !== null)
              onChange({ ...value, target: tab ? '_blank' : null });
          }}
        />
      </label>
    </>
  );
}
