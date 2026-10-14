import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import type {
  CatalogueEntry,
  CatalogueProperty,
  ModelNode,
  PreviewResponse,
} from '../../../api-types.js';
import { catalogueByKey } from '../../../client/session/move-action.js';
import {
  afterPreview,
  draftValues,
  NO_DRAFTS,
  reconcileDrafts,
  shownValue,
  withChange,
  type Drafts,
} from '../../../client/session/property-drafts.js';
import { breadcrumb, selectCrumb } from '../../../client/session/scope.js';
import { selectAndAnnounce } from '../../../client/session/selection-announcement.js';
import {
  useEditorStore,
  type EditorStore,
} from '../../../client/session/store.js';
import { labelOf, type ItemLabel } from '../../../client/session/tree-model.js';
import { formatString, STRINGS } from '../../strings.js';
import { PropertyField } from './controls.js';

/** What the panel asks of the shell when a property changes. */
export type PropertiesPanelProps = {
  readonly store: EditorStore;
  /**
   * Renders the block with `values` (every draft not refused) and, when the
   * engine accepts them, queues the save. Resolves with the engine's answer,
   * or `null` when a newer change superseded this one.
   */
  readonly onPropertiesChange?: (
    blockId: string,
    values: Readonly<Record<string, unknown>>,
    changedKey: string,
    immediate: boolean,
  ) => Promise<PreviewResponse | null>;
  /** A field lost focus: the block's edit is saved now. */
  readonly onPropertiesBlur?: (blockId: string) => void;
};

function textOf(label: ItemLabel): string {
  return label.kind === 'column'
    ? formatString('label.column', { n: String(label.n) })
    : label.text;
}

const CRUMB =
  'h-6 max-w-[120px] cursor-pointer truncate rounded-sm border-0 bg-transparent px-1 text-caption font-semibold text-text-muted hover:bg-surface-muted hover:text-text focus-visible:outline-2 focus-visible:outline-focus-ring';

const GROUP_HEADING = 'm-0 mb-2 text-body font-semibold text-text';

/** The item's label with the path to it in Caption muted. */
function PanelHeader(props: {
  readonly store: EditorStore;
  readonly node: ModelNode;
}): ReactElement | null {
  const { store, node } = props;
  const state = useEditorStore(store, (current) => current);
  const { model, session } = state;
  if (model === null || session === null) return null;
  const byKey = catalogueByKey(session.catalogue);
  const path = breadcrumb(model, node.id).map((item) => ({
    id: item.id,
    text: textOf(labelOf(model, byKey, item.id)),
  }));
  const own = path[path.length - 1]?.text ?? '';
  return (
    <header
      data-properties-header=""
      className="mb-4 border-b border-border pb-4"
    >
      <h2 className="m-0 text-body font-semibold text-text wrap-anywhere">
        {own}
      </h2>
      <nav
        aria-label={STRINGS['toolbar.breadcrumb']}
        className="mt-1 flex flex-wrap items-center gap-x-1"
      >
        {path.map((crumb, at) => (
          <span key={crumb.id} className="flex items-center gap-1">
            {at === 0 ? null : (
              <span aria-hidden="true" className="text-caption text-text-muted">
                ›
              </span>
            )}
            {crumb.id === node.id ? (
              <span
                aria-current="true"
                className="inline-block h-6 max-w-[120px] truncate px-1 text-caption leading-6 text-text-muted"
              >
                {crumb.text}
              </span>
            ) : (
              <button
                type="button"
                className={CRUMB}
                onClick={() => {
                  selectAndAnnounce(store, selectCrumb(model, crumb.id));
                }}
              >
                {crumb.text}
              </button>
            )}
          </span>
        ))}
      </nav>
    </header>
  );
}

/**
 * The editable properties of one item. The editor's changes live here as
 * drafts until the model has caught up with them, so a field's value, focus
 * and caret are never overwritten while it is being typed in; each change is
 * sent for a render and, when accepted, saved after a pause or on blur.
 */
function BlockProperties(props: {
  readonly store: EditorStore;
  readonly node: ModelNode;
  readonly entry: CatalogueEntry;
  readonly onPropertiesChange: PropertiesPanelProps['onPropertiesChange'];
  readonly onPropertiesBlur: PropertiesPanelProps['onPropertiesBlur'];
}): ReactElement {
  const { store, node, entry, onPropertiesChange, onPropertiesBlur } = props;
  const queue = useEditorStore(store, (state) => state.queue);
  const [drafts, setDraftState] = useState<Drafts>(NO_DRAFTS);
  const draftsRef = useRef<Drafts>(NO_DRAFTS);
  /** Which required values the latest render found empty, while drafts are open. */
  const [liveNeeds, setLiveNeeds] = useState<readonly string[] | null>(null);

  const setDrafts = useCallback((update: (current: Drafts) => Drafts) => {
    const next = update(draftsRef.current);
    draftsRef.current = next;
    setDraftState(next);
  }, []);

  // The model catching up with a draft (saved, or changed by an undo) ends it.
  useEffect(() => {
    setDrafts((current) => reconcileDrafts(current, node, queue));
  }, [node, queue, setDrafts]);

  const settle = useCallback(
    async (key: string, immediate: boolean): Promise<void> => {
      if (onPropertiesChange === undefined) return;
      const sent = Object.keys(draftValues(draftsRef.current));
      const values = draftValues(draftsRef.current);
      const response = await onPropertiesChange(
        node.id,
        values,
        key,
        immediate,
      );
      // A newer change to this block took over; its answer is the one that counts.
      if (response === null) return;
      if (response.ok) {
        setDrafts((current) => afterPreview(current, sent, null));
        setLiveNeeds(response.needsInput);
        return;
      }
      const named = response.issues
        .map((issue) => issue.key)
        .filter((issueKey) => sent.includes(issueKey));
      const refused = named.length > 0 ? named : [key];
      setDrafts((current) => afterPreview(current, sent, refused));
      // What was rendered together with a refused value is rendered again without it.
      if (sent.some((sentKey) => !refused.includes(sentKey))) {
        await settle(key, true);
      }
    },
    [node.id, onPropertiesChange, setDrafts],
  );

  const change = (
    property: CatalogueProperty,
    value: unknown,
    immediate: boolean,
  ): void => {
    setDrafts((current) => withChange(current, node, property.key, value));
    void settle(property.key, immediate);
  };

  const open = Object.keys(drafts).length > 0;
  const needs = open && liveNeeds !== null ? liveNeeds : node.needsInput;

  return (
    <section
      data-properties-group="settings"
      aria-label={STRINGS['panel.group.settings']}
    >
      <h3 className={GROUP_HEADING}>{STRINGS['panel.group.settings']}</h3>
      <div className="flex flex-col gap-4">
        {entry.properties.map((property) => {
          const draft = drafts[property.key];
          const fixed = property.constraint === 'fixed';
          const invalid = draft?.stage === 'invalid';
          return (
            <PropertyField
              key={property.key}
              fieldKey={property.key}
              label={property.label}
              {...(property.description === undefined
                ? {}
                : { description: property.description })}
              source={property}
              required={property.required}
              value={
                fixed
                  ? property.fixedValue
                  : shownValue(drafts, node, property.key)
              }
              needsInput={needs.includes(property.key)}
              error={
                invalid
                  ? property.constraint === 'narrowed'
                    ? STRINGS['panel.allowedError']
                    : STRINGS['panel.invalid']
                  : null
              }
              onChange={(value, immediate) => {
                change(property, value, immediate);
              }}
              onBlur={() => {
                onPropertiesBlur?.(node.id);
              }}
            />
          );
        })}
      </div>
    </section>
  );
}

function Note(props: { readonly children: string }): ReactElement {
  return (
    <p className="m-0 text-body text-text-muted wrap-anywhere">
      {props.children}
    </p>
  );
}

/**
 * The Properties tab: the selected item's label and path, then a control for
 * every property it declares. Nothing selected, an item with no properties, an
 * item whose type is unavailable and a column each say so instead.
 */
export function PropertiesPanel(props: PropertiesPanelProps): ReactElement {
  const { store, onPropertiesChange, onPropertiesBlur } = props;
  const state = useEditorStore(store, (current) => current);
  const { model, session, selection } = state;
  const node =
    state.status === 'editing' &&
    state.mode === 'edit' &&
    model !== null &&
    selection.selectedId !== null
      ? model.get(selection.selectedId)
      : undefined;

  if (node === undefined || session === null || model === null) {
    return (
      <div data-properties-empty="" className="flex flex-col gap-1">
        <h2 className="m-0 text-body font-semibold text-text">
          {STRINGS['panel.empty.heading']}
        </h2>
        <Note>{STRINGS['panel.empty.body']}</Note>
      </div>
    );
  }

  const entry = catalogueByKey(session.catalogue).get(node.type);
  const parent = model.parentOf(node.id);
  let body: ReactElement;
  if (node.kind === 'column') {
    body = (
      <div className="flex flex-col items-start gap-2">
        <Note>{STRINGS['panel.columnWidthNote']}</Note>
        {parent === null ? null : (
          <button
            type="button"
            data-open-section-layout=""
            className="h-10 cursor-pointer rounded-lg border border-control-border bg-surface px-3 text-body font-semibold text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            onClick={() => {
              selectAndAnnounce(store, selectCrumb(model, parent.id));
            }}
          >
            {STRINGS['panel.openSectionLayout']}
          </button>
        )}
      </div>
    );
  } else if (node.unavailable !== null || entry === undefined) {
    body = <Note>{STRINGS['panel.unavailable']}</Note>;
  } else if (entry.properties.length === 0) {
    body = <Note>{STRINGS['panel.noProperties']}</Note>;
  } else {
    body = (
      <BlockProperties
        key={node.id}
        store={store}
        node={node}
        entry={entry}
        onPropertiesChange={onPropertiesChange}
        onPropertiesBlur={onPropertiesBlur}
      />
    );
  }

  return (
    <div data-properties-panel="" data-properties-for={node.id}>
      <PanelHeader store={store} node={node} />
      {body}
    </div>
  );
}
