import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import type {
  PageSearchResponse,
  PageSearchResult,
} from '../../../api-types.js';
import { CheckIcon, PageIcon, SearchIcon, SpinnerIcon } from '../../icons.js';
import { formatString, STRINGS } from '../../strings.js';

/**
 * Finds the pages of a locale by title or path (the editor API's page search,
 * with the abort signal of the request). With `id` it looks that one page up
 * instead.
 */
export type PageSearch = (
  locale: string,
  query: string,
  signal: AbortSignal,
  id?: string,
) => Promise<PageSearchResponse>;

export type PagePickerProps = {
  readonly locale: string;
  readonly search: PageSearch;
  /** The page the pending target points at, shown with a check. */
  readonly selectedId: string | null;
  readonly onPick: (page: PageSearchResult) => void;
  /** Whether the search field takes the focus when the picker appears. */
  readonly focusOnMount: boolean;
};

/** A 40px text input of the link popover. */
export const LINK_INPUT =
  'box-border h-10 w-full min-w-0 rounded-md border border-border bg-surface px-2 text-body text-text focus-visible:outline-2 focus-visible:outline-focus-ring aria-invalid:border-destructive';

/** How long typing waits before a search is sent. */
const SEARCH_DELAY_MS = 150;

type Outcome =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | {
      readonly status: 'ready';
      readonly query: string;
      readonly results: readonly PageSearchResult[];
    };

/**
 * The page picker: a search field and, under it, a listbox of up to twenty
 * pages. An empty query lists the first pages by title. The field keeps the
 * focus and names the active row (`aria-activedescendant`); the arrows move
 * it, Enter picks it. Searches wait 150ms after typing and a newer one cancels
 * the older. A page that is not published can be chosen, and says so.
 */
export function PagePicker(props: PagePickerProps): ReactElement {
  const { locale, search, selectedId, onPick, focusOnMount } = props;
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<Outcome>({ status: 'loading' });
  const [active, setActive] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const base = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  useEffect(() => {
    // Only when the picker appears.
    if (focusOnMount) input.current?.focus();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setOutcome({ status: 'loading' });
    // The first list is asked for at once; typing waits for a pause.
    const delay = first.current ? 0 : SEARCH_DELAY_MS;
    first.current = false;
    const timer = setTimeout(() => {
      search(locale, query, controller.signal).then(
        (response) => {
          if (controller.signal.aborted) return;
          setOutcome({ status: 'ready', query, results: response.results });
          setActive(0);
        },
        () => {
          if (!controller.signal.aborted) setOutcome({ status: 'error' });
        },
      );
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, attempt, locale, search]);

  const results = outcome.status === 'ready' ? outcome.results : [];
  const idOf = (result: PageSearchResult): string => `${base}-${result.id}`;
  const activeResult = results[active];

  useEffect(() => {
    list.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, outcome]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((at) => (at + step + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (activeResult !== undefined) onPick(activeResult);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 flex-col gap-1">
        <label
          htmlFor={`${base}-search`}
          className="text-body font-semibold text-text"
        >
          {STRINGS['text.search.label']}
        </label>
        <div className="relative">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2 flex -translate-y-1/2 text-text-muted"
          >
            <SearchIcon />
          </span>
          <input
            ref={input}
            id={`${base}-search`}
            type="text"
            role="combobox"
            autoComplete="off"
            spellCheck={false}
            value={query}
            data-link-input="page"
            aria-autocomplete="list"
            aria-expanded={results.length > 0}
            aria-controls={`${base}-list`}
            aria-activedescendant={
              activeResult === undefined ? undefined : idOf(activeResult)
            }
            className={`${LINK_INPUT} pl-8`}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
      </div>
      {outcome.status === 'loading' ? (
        <p
          role="status"
          className="m-0 flex h-10 shrink-0 items-center gap-2 text-body text-text-muted"
        >
          <SpinnerIcon />
          {STRINGS['text.search.searching']}
        </p>
      ) : null}
      {outcome.status === 'error' ? (
        <div className="flex shrink-0 flex-col items-start gap-2">
          <p role="alert" className="m-0 text-body text-destructive">
            {STRINGS['text.search.error']}
          </p>
          <button
            type="button"
            className="h-8 cursor-pointer rounded-lg border border-control-border bg-surface px-3 text-caption font-semibold text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            onClick={() => {
              setAttempt(attempt + 1);
            }}
          >
            {STRINGS['text.search.retry']}
          </button>
        </div>
      ) : null}
      {outcome.status === 'ready' && results.length === 0 ? (
        <p className="m-0 text-body text-text-muted">
          {formatString('text.search.none', { query: outcome.query })}
        </p>
      ) : null}
      {results.length > 0 ? (
        <div
          ref={list}
          id={`${base}-list`}
          role="listbox"
          aria-labelledby={`${base}-search`}
          data-page-list=""
          className="-mx-2 min-h-[88px] min-w-0 flex-1 overflow-y-auto"
        >
          {results.map((result, index) => {
            const picked = result.id === selectedId;
            return (
              <div
                key={result.id}
                id={idOf(result)}
                role="option"
                aria-selected={picked}
                aria-label={result.title}
                aria-describedby={`${idOf(result)}-path`}
                data-active={index === active}
                data-page-id={result.id}
                className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-text hover:bg-surface-muted data-[active=true]:bg-surface-muted"
                // The search field keeps the focus while the pointer works the list.
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  onPick(result);
                }}
              >
                <span aria-hidden="true" className="flex shrink-0">
                  <PageIcon />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span
                    className="truncate text-body font-semibold"
                    title={result.title}
                  >
                    {result.title}
                  </span>
                  <span
                    id={`${idOf(result)}-path`}
                    className="truncate text-body text-text-muted"
                  >
                    {result.path}
                  </span>
                </span>
                {result.live ? null : (
                  <span className="shrink-0 text-caption text-text-muted">
                    {STRINGS['text.search.notPublished']}
                  </span>
                )}
                {picked ? (
                  <span aria-hidden="true" className="flex shrink-0">
                    <CheckIcon />
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
