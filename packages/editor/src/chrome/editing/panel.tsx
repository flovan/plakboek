import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import type { CatalogueEntry, EditPosition } from '../../api-types.js';
import {
  useEditorStore,
  type EditorStore,
  type PanelTab,
} from '../../client/session/store.js';
import { STRINGS } from '../strings.js';
import { Palette, type PaletteProps } from './palette.js';
import {
  PropertiesPanel,
  type PropertiesPanelProps,
} from './properties/properties-panel.js';

const TABS: readonly PanelTab[] = ['blocks', 'properties'];

const SEGMENT =
  'flex h-10 min-w-0 flex-1 cursor-pointer items-center justify-center border-0 bg-surface px-3 text-body font-semibold text-text -outline-offset-2 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring aria-selected:bg-text aria-selected:text-surface aria-selected:hover:bg-text';

export type SidePanelProps = Omit<PropertiesPanelProps, 'store'> & {
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

/**
 * The sidebar's panel region: a two-tab control, Blocks and Properties. Which
 * tab shows changes only by an explicit action (the tab itself, the toolbar's
 * Properties button, a double-click or Enter on a leaf, an insert that needs
 * input), never by selecting or clearing the selection. Both tabs stay mounted
 * so the palette's search and the panel's unsaved fields survive a switch.
 */
export function SidePanel(props: SidePanelProps): ReactElement | null {
  const { store, onInsert, onDragStart, ...panelProps } = props;
  const base = useId();
  const editing = useEditorStore(store, (state) => state.status === 'editing');
  const tab = useEditorStore(store, (state) => state.panelTab);
  const request = useEditorStore(store, (state) => state.propertiesRequest);
  const root = useRef<HTMLDivElement>(null);
  const tabs = useRef(new Map<PanelTab, HTMLButtonElement>());
  // A request that was already there when this panel mounted is not a new ask.
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

  const move = (event: KeyboardEvent<HTMLElement>): void => {
    const step =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length];
    if (next === undefined) return;
    store.setPanelTab(next);
    tabs.current.get(next)?.focus();
  };

  const tabButton = (value: PanelTab, label: string, divider: boolean) => (
    <button
      type="button"
      role="tab"
      id={`${base}-tab-${value}`}
      aria-selected={tab === value}
      aria-controls={`${base}-panel-${value}`}
      tabIndex={tab === value ? 0 : -1}
      data-panel-tab={value}
      ref={(element) => {
        if (element === null) tabs.current.delete(value);
        else tabs.current.set(value, element);
      }}
      onClick={() => {
        store.setPanelTab(value);
      }}
      className={
        divider ? `${SEGMENT} border-l border-control-border` : SEGMENT
      }
    >
      {label}
    </button>
  );

  return (
    <div ref={root} data-side-panel="" className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label={STRINGS['panel.tabs.label']}
        onKeyDown={move}
        className="mb-4 flex h-10 w-full shrink-0 overflow-hidden rounded-lg border border-control-border"
      >
        {tabButton('blocks', STRINGS['panel.tab.blocks'], false)}
        {tabButton('properties', STRINGS['panel.tab.properties'], true)}
      </div>
      <div
        role="tabpanel"
        id={`${base}-panel-blocks`}
        aria-labelledby={`${base}-tab-blocks`}
        hidden={tab !== 'blocks'}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <Palette store={store} onInsert={onInsert} onDragStart={onDragStart} />
      </div>
      <div
        role="tabpanel"
        id={`${base}-panel-properties`}
        aria-labelledby={`${base}-tab-properties`}
        hidden={tab !== 'properties'}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <PropertiesPanel store={store} {...panelProps} />
      </div>
    </div>
  );
}
