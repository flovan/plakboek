import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  useEditorStore,
  type EditorStore,
} from '../../client/session/store.js';
import { STRINGS } from '../strings.js';

/** The controls of the drawer that can take focus, in document order. */
const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Moves focus to the first control inside `root`, if there is one. */
function focusFirst(root: HTMLElement | null): void {
  root?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
}

/**
 * Closes the drawer and puts focus on the rail button that opened it. `origin`
 * is any element of the shell: it only finds the shadow root to search.
 */
export function closeDrawerAndRefocus(
  store: EditorStore,
  origin: Element,
): void {
  const opener = store.getState().drawer;
  store.closeDrawer();
  const root = origin.getRootNode();
  if (opener === null || !(root instanceof ShadowRoot)) return;
  root
    .querySelector<HTMLElement>(`[data-rail-button="${opener}"]`)
    ?.focus({ preventScroll: true });
}

/**
 * Escape closes an open drawer from anywhere inside it or the rail. A key that
 * something else already handled (a picker, a control's own popup) is left
 * alone.
 */
export function closeOnEscape(
  store: EditorStore,
  event: KeyboardEvent<HTMLElement>,
): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  if (store.getState().drawer === null) return;
  event.preventDefault();
  closeDrawerAndRefocus(store, event.currentTarget);
}

export type PanelDrawerProps = {
  readonly store: EditorStore;
  /** The notice slot: always the drawer's first element. */
  readonly notice: ReactNode;
  /** The lock row, under the notice. */
  readonly status: ReactNode;
  /** Page structure. */
  readonly panel: ReactNode;
  /** The Properties sheet, a layer over the drawer's content. */
  readonly sheet?: ReactNode;
  /** The sheet is open: the content scales down behind it and is hidden at the end. */
  readonly receded?: boolean;
};

/** The drawer's content behind the sheet: like the framed sidebar's body, it
 * scales to 94% and is hidden at the end of the transition, and is visible at
 * once on the way back (`visibility` is in the transition only while receding). */
const CONTENT =
  'visible flex min-h-0 flex-1 flex-col motion-safe:transition-[scale] motion-safe:duration-240 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] data-receded:invisible data-receded:scale-[0.94] motion-safe:data-receded:transition-[scale,visibility]';

/** Moves focus into the open sheet: its first control, else its Close button. */
function focusSheet(root: HTMLElement | null): void {
  const sheet = root?.querySelector('[data-properties-sheet]') ?? null;
  const target =
    sheet?.querySelector<HTMLElement>(
      '[data-properties-panel] [data-control]:not(:disabled)',
    ) ?? sheet?.querySelector<HTMLElement>('[data-sheet-close]');
  target?.focus();
}

/**
 * The full-width layout's panel drawer: 280px beside the rail, holding the
 * notice slot, the lock row and Page structure, with the Properties sheet
 * sliding over all of it when Properties are asked for. It is a column of the
 * shell's grid, so opening it narrows the frame instead of covering it (the
 * host's `data-drawer` attribute carries the column's width). It stays mounted
 * while closed, hidden, so what an editor typed in the panel and the panel's
 * answer to an explicit Properties request survive.
 *
 * Focus moves to the drawer's first control when a button opens it (into the
 * sheet when that is open), and back to that button when Escape or the button
 * closes it. A request for an item's Properties opens it too, and then the
 * sheet's own control gets focus instead.
 */
export function PanelDrawer(props: PanelDrawerProps): ReactElement {
  const { store, notice, status, panel, sheet, receded } = props;
  const open = useEditorStore(store, (state) => state.drawer !== null);
  const requestToken = useEditorStore(
    store,
    (state) => state.propertiesRequest?.token ?? 0,
  );
  const root = useRef<HTMLElement>(null);
  const seenRequest = useRef(requestToken);
  const wasOpen = useRef(false);

  useEffect(() => {
    const requested = requestToken !== seenRequest.current;
    seenRequest.current = requestToken;
    if (open && !wasOpen.current && !requested) {
      if (store.getState().propertiesOpen) focusSheet(root.current);
      else focusFirst(root.current);
    }
    wasOpen.current = open;
  }, [open, requestToken, store]);

  return (
    <section
      ref={root}
      aria-label={STRINGS['rail.drawer']}
      hidden={!open}
      data-drawer-panel=""
      className="pk-drawer"
      onKeyDown={(event) => {
        closeOnEscape(store, event);
      }}
    >
      <div
        data-drawer-content=""
        data-receded={receded === true ? '' : undefined}
        className={CONTENT}
      >
        {notice}
        {status}
        <div data-slot="panel" className="min-h-0 flex-1 overflow-y-auto">
          {panel}
        </div>
      </div>
      {sheet}
    </section>
  );
}
