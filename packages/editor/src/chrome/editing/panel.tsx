import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import type { CatalogueEntry, EditPosition } from '../../api-types.js';
import {
  useEditorStore,
  type EditorStore,
} from '../../client/session/store.js';
import { CloseIcon } from '../icons.js';
import { STAGE_ID } from '../stage.js';
import { STRINGS } from '../strings.js';
import { Palette, type PaletteProps } from './palette.js';
import {
  PropertiesPanel,
  type PropertiesPanelProps,
} from './properties/properties-panel.js';

export type SidePanelProps = {
  readonly store: EditorStore;
  /** The editor chose a block type and a place for it in the palette. */
  readonly onInsert: (entry: CatalogueEntry, position: EditPosition) => void;
  /** A palette row was pressed: it becomes a drag once the pointer has moved 4px. */
  readonly onDragStart?: PaletteProps['onDragStart'];
};

/**
 * Moves focus to the first control of the open Properties panel that still
 * needs input, else to its first control. Only an explicit ask does this
 * (a double-click or Enter on a leaf, the toolbar's Properties button, an
 * insert that needs input); selecting never does.
 */
function focusFirstControl(root: HTMLElement | null): void {
  const panel = root?.querySelector('[data-properties-panel]') ?? null;
  if (panel === null) return;
  const target =
    panel.querySelector<HTMLElement>(
      '[data-needs-input] [data-control]:not(:disabled)',
    ) ?? panel.querySelector<HTMLElement>('[data-control]:not(:disabled)');
  target?.focus();
}

/** Puts focus on the page region, the editor's place to carry on from. */
function focusStage(from: Element | null): void {
  const root = from?.getRootNode();
  if (!(root instanceof ShadowRoot)) return;
  root.getElementById(STAGE_ID)?.focus({ preventScroll: true });
}

/**
 * The sidebar's panel region: the Blocks palette. Properties are not a tab
 * here; they open in the {@link PropertiesSheet} over this region.
 */
export function SidePanel(props: SidePanelProps): ReactElement | null {
  const { store, onInsert, onDragStart } = props;
  const editing = useEditorStore(store, (state) => state.status === 'editing');
  if (!editing) return null;
  return (
    <div data-side-panel="" className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Palette store={store} onInsert={onInsert} onDragStart={onDragStart} />
      </div>
    </div>
  );
}

const CLOSE_BUTTON =
  'flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-control-border bg-surface px-3 text-caption font-semibold text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

/**
 * The slide: closed it sits a whole width to the left and is hidden, with
 * `visibility` in the transition only in the direction that hides it, so the
 * layer being shown is visible at once (see the rail's layer). Only the
 * transform-family `translate` and the scrim's opacity move.
 */
const SHEET =
  'invisible absolute inset-0 z-10 flex min-h-0 flex-col bg-surface p-4 -translate-x-full motion-safe:transition-[translate,visibility] motion-safe:duration-240 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] data-open:visible data-open:translate-x-0 motion-safe:data-open:transition-[translate]';

const SCRIM =
  'pointer-events-none absolute inset-0 z-[5] bg-scrim opacity-0 motion-safe:transition-opacity motion-safe:duration-240 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] data-open:opacity-100';

export type PropertiesSheetProps = PropertiesPanelProps & {
  /** What needs attention while the sheet is open: the notice slot and the lock row. */
  readonly top?: ReactNode;
  /** Pinned under the content behind a 1px line: the save status. */
  readonly footer?: ReactNode;
};

/**
 * The focused Properties mode: a layer over the sidebar (or the drawer) that
 * holds the selected item's Properties under a header with a Close button. It
 * stays mounted while closed, hidden, so what an editor typed survives. An
 * explicit request moves focus to the first empty required control, else the
 * first control.
 */
export function PropertiesSheet(
  props: PropertiesSheetProps,
): ReactElement | null {
  const { top, footer, ...panelProps } = props;
  const { store } = panelProps;
  const editing = useEditorStore(store, (state) => state.status === 'editing');
  const open = useEditorStore(store, (state) => state.propertiesOpen);
  const request = useEditorStore(store, (state) => state.propertiesRequest);
  const root = useRef<HTMLElement>(null);
  // A request that was already there when the sheet mounted is not a new ask.
  const handled = useRef(request?.token ?? 0);

  useEffect(() => {
    if (request === null || request.token === handled.current) return undefined;
    handled.current = request.token;
    const frame = requestAnimationFrame(() => {
      focusFirstControl(root.current);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [request]);

  if (!editing) return null;

  const close = (): void => {
    store.closeProperties();
    focusStage(root.current);
  };

  return (
    <>
      <div
        aria-hidden="true"
        data-open={open ? '' : undefined}
        className={SCRIM}
      />
      <section
        ref={root}
        aria-label={STRINGS['sheet.heading']}
        data-properties-sheet=""
        data-open={open ? '' : undefined}
        className={SHEET}
      >
        {top}
        <div className="mb-4 flex shrink-0 items-center justify-between gap-2">
          <h2 className="m-0 text-body font-semibold text-text">
            {STRINGS['sheet.heading']}
          </h2>
          <button
            type="button"
            data-sheet-close=""
            aria-label={STRINGS['sheet.closeLabel']}
            onClick={close}
            className={CLOSE_BUTTON}
          >
            <CloseIcon />
            {STRINGS['sheet.close']}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PropertiesPanel {...panelProps} />
        </div>
        {footer === undefined || footer === null ? null : (
          <div className="mt-4 shrink-0 border-t border-border pt-4">
            {footer}
          </div>
        )}
      </section>
    </>
  );
}
