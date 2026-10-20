import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { isAllowedHref, type LinkTarget } from '@plakboek/content/rich-text';
import { STRINGS } from '../../strings.js';
import { LINK_INPUT, PagePicker, type PageSearch } from './page-picker.js';

export type LinkTargetEditorProps = {
  /** The pending target: the stored one when editing, the last valid one while typing; null before any. */
  readonly value: LinkTarget | null;
  /** The locale whose pages the picker lists. */
  readonly locale: string;
  /**
   * Finds pages. Without it there is no page picker and no segments: only a
   * web address can be entered.
   */
  readonly search?: PageSearch;
  /**
   * Called with each target that is complete and allowed, as it is typed or
   * picked, with the picked page's title (null for an address). An invalid
   * address is not reported, so the owner keeps the last valid target.
   */
  readonly onChange: (target: LinkTarget, title: string | null) => void;
  /** Enter in the address input with a valid address: the owner applies. */
  readonly onSubmit?: () => void;
  /**
   * Whether the first field takes the focus when the section appears. A
   * popover whose own first field is elsewhere (the Button popover's label)
   * turns it off; pressing a segment still moves the focus into the field.
   */
  readonly focusOnOpen?: boolean;
};

type Segment = 'page' | 'web';

/** A 40px by 24px track; a checked one is filled with the text colour. */
const SWITCH =
  'relative h-6 w-10 shrink-0 cursor-pointer appearance-none rounded-full border border-control-border bg-surface-muted before:absolute before:top-0.5 before:left-0.5 before:size-[18px] before:rounded-full before:bg-text checked:bg-text checked:before:translate-x-4 checked:before:bg-surface focus-visible:outline-2 focus-visible:outline-focus-ring';

/** A segment of the "Link to" control: the selected one takes the inverted fill. */
export const SEGMENT =
  'h-10 flex-1 cursor-pointer rounded-md border-0 bg-transparent px-3 text-body font-semibold text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring aria-checked:bg-text aria-checked:text-surface aria-checked:hover:bg-text';

const SEGMENTS: readonly { readonly id: Segment; readonly label: string }[] = [
  { id: 'page', label: STRINGS['text.linkTo.page'] },
  { id: 'web', label: STRINGS['text.linkTo.web'] },
];

type WebAddressProps = {
  readonly initial: string;
  readonly focusOnMount: boolean;
  /** Reports an address that passed the policy; `text` is what the input shows. */
  readonly onValid: (address: string) => void;
  readonly onSubmit: (() => void) | undefined;
  /** What the input shows is remembered by the owner, so a segment switch keeps it. */
  readonly onText: (text: string) => void;
};

/** The address input: valid addresses apply as they are typed, an invalid one says why once the input is left. */
function WebAddress(props: WebAddressProps): ReactElement {
  const { initial, focusOnMount, onValid, onSubmit, onText } = props;
  const [text, setText] = useState(initial);
  const [showError, setShowError] = useState(false);
  const inputId = useId();
  const noteId = useId();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Only when the input appears.
    if (focusOnMount) input.current?.focus();
  }, []);

  const trimmed = text.trim();
  const valid = trimmed !== '' && isAllowedHref(trimmed);
  const invalid = showError && trimmed !== '' && !valid;

  return (
    <div className="flex shrink-0 flex-col gap-1">
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
          onText(next);
          const address = next.trim();
          if (address !== '' && isAllowedHref(address)) {
            setShowError(false);
            onValid(address);
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
          onValid(trimmed);
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
  );
}

/**
 * Whether the page a stored link points at is gone: asks the search route for
 * that one id. A lookup that fails says nothing, so it is not "gone".
 */
function usePageGone(
  search: PageSearch | undefined,
  locale: string,
  pageId: string | null,
): boolean {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (search === undefined || pageId === null) return undefined;
    const controller = new AbortController();
    search(locale, '', controller.signal, pageId).then(
      (response) => {
        if (!controller.signal.aborted) setGone(response.results.length === 0);
      },
      () => undefined,
    );
    return () => {
      controller.abort();
    };
    // The page the popover opened on; later picks are of pages that exist.
  }, []);
  return gone;
}

/**
 * The Link target section: where a link points and whether it opens in a new
 * tab. It is shared by the link popover and, in later plans, the button
 * popover and the Button block, so a target is picked the same way
 * everywhere. It edits a pending target and reports each valid one; it never
 * writes anything itself.
 *
 * With a page search there are two ways to point: at a page of the
 * installation (stored by id, so a renamed page keeps its links) or at a web
 * address, `mailto:` or `tel:`. It opens on the way the current target uses,
 * else on Page.
 */
export function LinkTargetEditor(props: LinkTargetEditorProps): ReactElement {
  const { value, locale, search, onChange, onSubmit } = props;
  const focusOnOpen = props.focusOnOpen !== false;
  const [segment, setSegment] = useState<Segment>(
    search === undefined || (value?.pageId === null && value.href !== null)
      ? 'web'
      : 'page',
  );
  // The first field takes the focus when the section appears and when a
  // segment is pressed; the arrow keys of the segments keep it on them.
  const [focusField, setFocusField] = useState(focusOnOpen);
  const [newTab, setNewTab] = useState(value?.target === '_blank');
  // What the address input showed last, so a round trip through Page keeps it.
  const [webText, setWebText] = useState(value?.href ?? '');
  const gone = usePageGone(search, locale, value?.pageId ?? null);
  const target = newTab ? '_blank' : null;

  const choose = (next: Segment, withFocus: boolean): void => {
    setFocusField(withFocus);
    setSegment(next);
  };

  const onSegmentKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const next: Segment = segment === 'page' ? 'web' : 'page';
    choose(next, false);
    // The newly selected radio is the one tab stop; focus follows the selection.
    requestAnimationFrame(() => {
      (event.currentTarget as HTMLElement)
        .querySelector<HTMLElement>(`[data-segment="${next}"]`)
        ?.focus();
    });
  };

  return (
    <>
      {search === undefined ? null : (
        <div
          role="radiogroup"
          aria-label={STRINGS['text.linkTo']}
          className="flex shrink-0 gap-1 rounded-lg border border-border p-0.5"
          onKeyDown={onSegmentKeyDown}
        >
          {SEGMENTS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-checked={segment === entry.id}
              tabIndex={segment === entry.id ? 0 : -1}
              data-segment={entry.id}
              className={SEGMENT}
              onClick={() => {
                choose(entry.id, true);
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}
      {segment === 'page' && search !== undefined ? (
        <>
          {gone ? (
            <p
              role="alert"
              data-link-broken=""
              className="m-0 shrink-0 text-body text-destructive"
            >
              {STRINGS['text.link.broken']}
            </p>
          ) : null}
          <PagePicker
            locale={locale}
            search={search}
            selectedId={value?.pageId ?? null}
            focusOnMount={focusField}
            onPick={(page) => {
              onChange({ href: null, pageId: page.id, target }, page.title);
            }}
          />
        </>
      ) : (
        <WebAddress
          initial={webText}
          focusOnMount={focusField}
          onText={setWebText}
          onSubmit={onSubmit}
          onValid={(address) => {
            onChange({ href: address, pageId: null, target }, null);
          }}
        />
      )}
      <label className="flex h-10 shrink-0 items-center justify-between gap-2 text-body text-text">
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
            if (value !== null) {
              onChange({ ...value, target: tab ? '_blank' : null }, null);
            }
          }}
        />
      </label>
    </>
  );
}
