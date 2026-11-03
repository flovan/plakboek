import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { isCompleteCta } from '@plakboek/content/rich-text';
import { EDIT_ATTRIBUTE } from '@plakboek/render';
import { documentBox } from '../../../client/chrome-host/coordinates.js';
import { sameBox, type Box } from '../../../client/overlay/geometry.js';
import type { FieldBox } from '../../../client/overlay/field-boxes.js';
import {
  useEditorStore,
  type EditorStore,
} from '../../../client/session/store.js';
import { selectedCta } from '../../../client/text/cta.js';
import type { TextController } from '../../../client/text/controller.js';
import {
  incompleteCtas,
  rangesForRuns,
  type JsonNode,
} from '../../../client/text/style-runs.js';
import { AlertIcon } from '../../icons.js';
import { STRINGS } from '../../strings.js';

/** One marker: the button's box and what it lacks. */
type Marker = {
  readonly box: Box;
  readonly lacks: 'label' | 'link';
};

type Drawn = {
  readonly markers: readonly Marker[];
  /** The selected button's box, while its field is being edited. */
  readonly selected: Box | null;
};

const NOTHING: Drawn = { markers: [], selected: null };

const BLOCK_SELECTOR = `[${EDIT_ATTRIBUTE.block}]`;
const FIELD_SELECTOR = `[${EDIT_ATTRIBUTE.field}]`;

/** The block's own field with this key, never one of a nested block's. */
function fieldElement(
  frameDocument: Document,
  blockId: string,
  key: string,
): Element | null {
  const block = Array.from(frameDocument.querySelectorAll(BLOCK_SELECTOR)).find(
    (element) => element.getAttribute(EDIT_ATTRIBUTE.block) === blockId,
  );
  if (block === undefined) return null;
  const candidates = [
    ...(block.matches(FIELD_SELECTOR) ? [block] : []),
    ...block.querySelectorAll(FIELD_SELECTOR),
  ];
  return (
    candidates.find(
      (field) =>
        field.getAttribute(EDIT_ATTRIBUTE.field) === key &&
        field.closest(BLOCK_SELECTOR) === block,
    ) ?? null
  );
}

function boxStyle(box: Box): CSSProperties {
  return {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
  };
}

function sameDrawn(a: Drawn, b: Drawn): boolean {
  return (
    a.markers.length === b.markers.length &&
    a.markers.every((marker, at) => {
      const other = b.markers[at];
      return (
        other !== undefined &&
        other.lacks === marker.lacks &&
        sameBox(other.box, marker.box)
      );
    }) &&
    (a.selected === null || b.selected === null
      ? a.selected === b.selected
      : sameBox(a.selected, b.selected))
  );
}

function elementOf(node: Node): Element | null {
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

export type CtaMarkersProps = {
  readonly store: EditorStore;
  /** The text session: while a field is active its buttons come from the live editor. */
  readonly controller: TextController | undefined;
  /** The frame the fields are in. */
  readonly frame: HTMLIFrameElement | null;
  /** The rich text fields of the selected block, as the overlay measured them. */
  readonly fields: readonly FieldBox[];
};

/**
 * The Phase 8 marker look on every button of the selected block's text that
 * lacks a label or a link: "Needs a label" or "Needs a link" at its top-right
 * corner, and, while the field is being edited, the selection box of the
 * selected button. Decoration only: no pointer events and hidden from
 * assistive technology (the Button popover says the same in text), never part
 * of the page's own markup or of a visitor response, where an incomplete
 * button is not rendered at all.
 *
 * An active field is read from the live editor, exactly. A field that is only
 * selected is read from the stored value and its buttons are found by their
 * label text in the rendered field, and only while the field's text is what
 * the stored value says; a button with no label has no text to find, so it is
 * marked once the field is active.
 */
export function CtaMarkers(props: CtaMarkersProps): ReactElement | null {
  const { store, controller, frame, fields } = props;
  const blockId = useEditorStore(store, (state) => state.selection.selectedId);
  const model = useEditorStore(store, (state) => state.model);
  const textField = useEditorStore(store, (state) => state.textField);
  const [drawn, setDrawn] = useState<Drawn>(NOTHING);

  useEffect(() => {
    const frameDocument = frame?.contentDocument ?? null;
    const view = frameDocument?.defaultView ?? null;
    const topWindow = frame?.ownerDocument.defaultView ?? null;
    if (
      frameDocument === null ||
      view === null ||
      topWindow === null ||
      blockId === null ||
      fields.length === 0
    ) {
      setDrawn((previous) => (previous === NOTHING ? previous : NOTHING));
      return undefined;
    }
    let pending = 0;
    let disposed = false;

    const compute = (): void => {
      pending = 0;
      if (disposed) return;
      const markers: Marker[] = [];
      let selected: Box | null = null;
      for (const field of fields) {
        if (field.kind !== 'rich') continue;
        const live = controller?.editor() ?? null;
        if (
          textField !== null &&
          textField.key === field.key &&
          textField.blockId === blockId &&
          !textField.unsupported &&
          live !== null
        ) {
          const chosen = selectedCta(live.state);
          live.state.doc.descendants((node, pos) => {
            if (node.type.name !== 'cta') return true;
            const dom = live.view.nodeDOM(pos) as Partial<HTMLElement> | null;
            if (
              dom === null ||
              typeof dom.getBoundingClientRect !== 'function'
            ) {
              return false;
            }
            const box = documentBox(dom.getBoundingClientRect(), view);
            if (chosen !== null && chosen.pos === pos) selected = box;
            if (!isCompleteCta(node.attrs)) {
              const label: unknown = node.attrs['label'];
              markers.push({
                box,
                lacks:
                  typeof label === 'string' && label.trim() !== ''
                    ? 'link'
                    : 'label',
              });
            }
            return false;
          });
          continue;
        }
        const stored = model?.get(blockId)?.props[field.key];
        const element = fieldElement(frameDocument, blockId, field.key);
        if (element === null || typeof stored !== 'object' || stored === null) {
          continue;
        }
        const doc = stored as JsonNode;
        for (const cta of incompleteCtas(doc)) {
          if (cta.end <= cta.start) continue;
          const [range] = rangesForRuns(element, doc, [
            { kind: 'style', start: cta.start, end: cta.end },
          ]);
          const host =
            range === undefined ? null : elementOf(range.range.startContainer);
          if (host === null) continue;
          markers.push({
            box: documentBox(host.getBoundingClientRect(), view),
            lacks: cta.lacks,
          });
        }
      }
      const next: Drawn = { markers, selected };
      setDrawn((previous) => (sameDrawn(previous, next) ? previous : next));
    };
    const schedule = (): void => {
      if (pending === 0 && !disposed) {
        pending = topWindow.requestAnimationFrame(compute);
      }
    };

    schedule();
    const unsubscribe = controller?.subscribe(schedule);
    return () => {
      disposed = true;
      unsubscribe?.();
      if (pending !== 0) topWindow.cancelAnimationFrame(pending);
    };
  }, [frame, blockId, fields, model, textField, controller]);

  if (drawn.markers.length === 0 && drawn.selected === null) return null;
  return (
    <div className="pk-cta-decor" aria-hidden="true" data-cta-decor="">
      {drawn.selected === null ? null : (
        <div
          className="pk-overlay-outline"
          data-cta-selected=""
          style={boxStyle(drawn.selected)}
        />
      )}
      {drawn.markers.map((marker) => (
        <div
          key={`${marker.box.left}:${marker.box.top}`}
          className="pk-marker-pin"
          data-side="right"
          style={boxStyle(marker.box)}
        >
          <span className="pk-cta-marker" data-cta-marker={marker.lacks}>
            <AlertIcon />
            {marker.lacks === 'label'
              ? STRINGS['text.cta.needsLabel']
              : STRINGS['text.cta.needsLink']}
          </span>
        </div>
      ))}
    </div>
  );
}
