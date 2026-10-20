import { useEffect, useState, type ReactElement } from 'react';
import { EDIT_ATTRIBUTE } from '@plakboek/render';
import { documentBox } from '../../../client/chrome-host/coordinates.js';
import type { FieldBox } from '../../../client/overlay/field-boxes.js';
import {
  useEditorStore,
  type EditorStore,
} from '../../../client/session/store.js';
import type { TextController } from '../../../client/text/controller.js';
import {
  customStylePositions,
  customStyleRuns,
  rangesForPositions,
  rangesForRuns,
  type JsonNode,
  type MarkedRange,
} from '../../../client/text/style-runs.js';

/** One dashed bar, in the framed document's coordinates. */
type Bar = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
};

const BLOCK_SELECTOR = `[${EDIT_ATTRIBUTE.block}]`;
const FIELD_SELECTOR = `[${EDIT_ATTRIBUTE.field}]`;
const ALIGNED_BLOCK = 'p, h1, h2, h3, h4, h5, h6';

export function fieldElement(
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

function elementOf(node: Node): Element | null {
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

/**
 * The bars under one marked range: one per line box, along its bottom edge.
 * Text with custom style is marked under the text of each line it takes; an
 * alignment is marked along the whole measure of its paragraph.
 */
function barsOf(marked: MarkedRange, view: Window): Bar[] {
  const rects = [...marked.range.getClientRects()].filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );
  if (marked.kind === 'style') {
    return rects.map((rect) => barAt(rect.left, rect.bottom, rect.width, view));
  }
  const block = elementOf(marked.range.startContainer)?.closest(ALIGNED_BLOCK);
  if (block === null || block === undefined) return [];
  const measure = block.getBoundingClientRect();
  const lines = new Map<number, number>();
  for (const rect of rects) lines.set(Math.round(rect.bottom), rect.bottom);
  return [...lines.values()].map((bottom) =>
    barAt(measure.left, bottom, measure.width, view),
  );
}

function barAt(left: number, bottom: number, width: number, view: Window): Bar {
  const box = documentBox({ left, top: bottom, width, height: 0 }, view);
  return { left: box.left, top: box.top, width };
}

function sameBars(a: readonly Bar[], b: readonly Bar[]): boolean {
  return (
    a.length === b.length &&
    a.every((bar, at) => {
      const other = b[at];
      return (
        other !== undefined &&
        Math.abs(bar.left - other.left) < 0.5 &&
        Math.abs(bar.top - other.top) < 0.5 &&
        Math.abs(bar.width - other.width) < 0.5
      );
    })
  );
}

export type CustomStyleMarkerProps = {
  readonly store: EditorStore;
  /** The text session: while a field is active its runs come from the live editor. */
  readonly controller: TextController | undefined;
  /** The frame the fields are in. */
  readonly frame: HTMLIFrameElement | null;
  /** The rich text fields of the selected block, as the overlay measured them. */
  readonly fields: readonly FieldBox[];
};

/**
 * The D-10 marker: a 2px dashed bar under every line box of text that carries
 * a custom colour or size, and along the measure of a paragraph or heading
 * with a custom alignment, so drift from the theme is never invisible while
 * editing. It is drawn only for the selected block's fields (so only while the
 * block is selected or its field is active, never on hover), in the chrome
 * host, as decoration: no pointer events, hidden from assistive technology,
 * never part of the page's own markup or of a visitor response.
 *
 * It is worked out again when the selection, the page data, a transaction of
 * the field being edited or a measured box changes, never on scroll (the bars
 * live in document coordinates and scroll with the page). A stored field whose
 * rendered text differs from its stored text (a host renderer that adds text
 * of its own) is not marked until it is active.
 */
export function CustomStyleMarker(
  props: CustomStyleMarkerProps,
): ReactElement | null {
  const { store, controller, frame, fields } = props;
  const blockId = useEditorStore(store, (state) => state.selection.selectedId);
  const model = useEditorStore(store, (state) => state.model);
  const textField = useEditorStore(store, (state) => state.textField);
  const [bars, setBars] = useState<readonly Bar[]>([]);

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
      setBars((previous) => (previous.length === 0 ? previous : []));
      return undefined;
    }
    let pending = 0;
    let disposed = false;

    const compute = (): void => {
      pending = 0;
      if (disposed) return;
      const found: Bar[] = [];
      const seen = new Set<string>();
      for (const field of fields) {
        if (field.kind !== 'rich') continue;
        let ranges: MarkedRange[] = [];
        const live = controller?.editor() ?? null;
        if (
          textField !== null &&
          textField.key === field.key &&
          textField.blockId === blockId &&
          textField.unsupported !== true &&
          live !== null
        ) {
          ranges = rangesForPositions(
            live.view,
            customStylePositions(live.state.doc),
          );
        } else {
          const stored = model?.get(blockId)?.props[field.key];
          const element = fieldElement(frameDocument, blockId, field.key);
          if (
            element !== null &&
            typeof stored === 'object' &&
            stored !== null
          ) {
            const doc = stored as JsonNode;
            ranges = rangesForRuns(element, doc, customStyleRuns(doc));
          }
        }
        for (const marked of ranges) {
          for (const bar of barsOf(marked, view)) {
            const id = `${Math.round(bar.left)}:${Math.round(bar.top)}:${Math.round(bar.width)}`;
            if (seen.has(id)) continue;
            seen.add(id);
            found.push(bar);
          }
        }
      }
      setBars((previous) => (sameBars(previous, found) ? previous : found));
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

  if (bars.length === 0) return null;
  return (
    <div className="pk-custom-style" aria-hidden="true" data-custom-style="">
      {bars.map((bar) => (
        <div
          key={`${bar.left}:${bar.top}:${bar.width}`}
          className="pk-custom-style-bar"
          data-custom-style-bar=""
          style={{ left: bar.left, top: bar.top, width: bar.width }}
        />
      ))}
    </div>
  );
}
