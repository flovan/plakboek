/**
 * Runs the drags of the shell: it wires the pointer controller and the
 * keyboard state machine to the session store, the framed page and the writes.
 * Only one drag runs at a time. A drop is a move or an insert at the resolved
 * position, saved at once like any structural action; a drop that would leave an
 * item where it is writes nothing, and a cancel changes nothing.
 */
import type { CatalogueEntry, EditPosition } from '../../api-types.js';
import { startPointerDrag } from '../drag/controller.js';
import { EMPTY_FEED } from '../drag/feed.js';
import {
  createKeyboardDrag,
  type KeyboardDirection,
  type KeyboardDrag,
} from '../drag/keyboard.js';
import { createSceneReader, type SceneReader } from '../drag/scene.js';
import {
  currentPosition,
  labelTextOf,
  samePosition,
  type DragSubject,
} from '../drag/slots.js';
import type { Box, Point } from '../overlay/geometry.js';
import { legalityContextOf } from '../session/move-action.js';
import type { EditorStore } from '../session/store.js';

export type DragSessionOptions = {
  readonly store: EditorStore;
  readonly frame: () => HTMLIFrameElement | null;
  /** Saves the move of an item to a position. */
  readonly onMove: (id: string, position: EditPosition) => void;
  /** Saves a new item of a type at a position. */
  readonly onInsert: (entry: CatalogueEntry, position: EditPosition) => void;
  /** Hands focus back once a keyboard drag has ended. */
  readonly onKeyboardEnd: () => void;
};

export type DragSession = {
  /** A press on a source: the drag starts once the pointer has moved 4px. */
  startPointer(subject: DragSubject, origin: Point): void;
  /** Space or Enter on the handle of an item. */
  liftKeyboard(id: string): void;
  /** Ends whatever drag runs, with no change. */
  abandon(): void;
};

const ARROWS: ReadonlyMap<string, KeyboardDirection> = new Map([
  ['ArrowUp', 'up'],
  ['ArrowDown', 'down'],
  ['ArrowLeft', 'left'],
  ['ArrowRight', 'right'],
]);

/** How much frame room a line keeps clear of the top and bottom when it is scrolled into view. */
const REVEAL_MARGIN = 48;

/** Scrolls the frame, if need be, so a line is inside it with some room to spare. */
function reveal(frame: HTMLIFrameElement, line: Box): void {
  const view = frame.contentWindow;
  if (view === null) return;
  const height = frame.clientHeight;
  if (line.top < REVEAL_MARGIN) {
    view.scrollBy({ top: line.top - REVEAL_MARGIN, behavior: 'instant' });
  } else if (line.top + line.height > height - REVEAL_MARGIN) {
    view.scrollBy({
      top: line.top + line.height - (height - REVEAL_MARGIN),
      behavior: 'instant',
    });
  }
}

export function createDragSession(options: DragSessionOptions): DragSession {
  const { store } = options;
  let stop: (() => void) | null = null;

  function labelOf(subject: DragSubject): string | null {
    const ctx = legalityContextOf(store.getState());
    if (ctx === null) return null;
    if (subject.kind === 'insert') {
      return ctx.catalogue.get(subject.type)?.editor.label ?? subject.type;
    }
    return ctx.model.get(subject.id) === undefined
      ? null
      : labelTextOf(ctx, subject.id);
  }

  function drop(subject: DragSubject, position: EditPosition): void {
    const state = store.getState();
    if (state.status !== 'editing' || state.mode !== 'edit') return;
    if (state.model === null) return;
    if (subject.kind === 'move') {
      const here = currentPosition(state.model, subject.id);
      if (here !== null && samePosition(here, position)) return;
      options.onMove(subject.id, position);
      return;
    }
    const entry = state.session?.catalogue.find(
      (candidate) => candidate.key === subject.type,
    );
    if (entry !== undefined) options.onInsert(entry, position);
  }

  function closeDrag(reader: SceneReader): void {
    reader.dispose();
    store.dragFeed.set(EMPTY_FEED);
    store.setDrag(null);
  }

  return {
    startPointer(subject, origin) {
      const frame = options.frame();
      const state = store.getState();
      const label = labelOf(subject);
      if (
        stop !== null ||
        frame === null ||
        label === null ||
        state.drag !== null ||
        state.status !== 'editing' ||
        state.mode !== 'edit'
      ) {
        return;
      }
      const reader = createSceneReader(frame, () => store.getState().model);
      stop = startPointerDrag({
        subject,
        ctx: () => legalityContextOf(store.getState()),
        sceneOf: reader.read,
        frame,
        origin,
        onActivate: () => {
          store.setDrag({ via: 'pointer', subject, label, active: true });
        },
        onUpdate: ({ pointer, slot }) => {
          store.dragFeed.set({
            pointer,
            line: slot?.line ?? null,
            axis: slot?.axis ?? null,
          });
        },
        onDrop: (position) => {
          drop(subject, position);
        },
        onCancel: () => undefined,
        onEnd: () => {
          stop = null;
          closeDrag(reader);
        },
      });
    },

    liftKeyboard(id) {
      const frame = options.frame();
      const state = store.getState();
      const subject: DragSubject = { kind: 'move', id };
      const label = labelOf(subject);
      if (
        stop !== null ||
        frame === null ||
        label === null ||
        state.drag !== null ||
        state.status !== 'editing' ||
        state.mode !== 'edit'
      ) {
        return;
      }
      const reader = createSceneReader(frame, () => store.getState().model);
      const view = frame.ownerDocument.defaultView;
      const frameView = frame.contentWindow;
      let teardown = (): void => undefined;
      const drag: KeyboardDrag = createKeyboardDrag({
        subject,
        label,
        ctx: () => legalityContextOf(store.getState()),
        sceneOf: reader.read,
        announce: (text) => {
          store.announce(text);
        },
        onSlot: (slot) => {
          store.dragFeed.set(
            slot === null
              ? EMPTY_FEED
              : { pointer: null, line: slot.line, axis: slot.axis },
          );
        },
        reveal: (line) => {
          reveal(frame, line);
        },
        onDrop: (position) => {
          drop(subject, position);
        },
        onEnd: () => {
          teardown();
          stop = null;
          closeDrag(reader);
          options.onKeyboardEnd();
        },
      });
      if (!drag.lift()) {
        reader.dispose();
        return;
      }
      store.setDrag({ via: 'keyboard', subject, label, active: true });

      // While lifted the keys belong to the drag, wherever focus has gone.
      const onKey = (event: KeyboardEvent): void => {
        const direction = ARROWS.get(event.key);
        if (direction !== undefined) {
          drag.step(direction);
        } else if (event.key === ' ' || event.key === 'Enter') {
          if (!event.repeat) drag.drop();
        } else if (event.key === 'Escape') {
          drag.cancel();
        } else {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
      };
      const onPress = (): void => {
        drag.cancel();
      };
      const onScroll = (): void => {
        drag.redraw();
      };
      const unsubscribe = store.subscribe(() => {
        const next = store.getState();
        if (next.status !== 'editing' || next.mode !== 'edit') drag.cancel();
      });
      view?.addEventListener('keydown', onKey, true);
      view?.addEventListener('pointerdown', onPress, true);
      frameView?.addEventListener('scroll', onScroll, { passive: true });
      teardown = () => {
        unsubscribe();
        view?.removeEventListener('keydown', onKey, true);
        view?.removeEventListener('pointerdown', onPress, true);
        frameView?.removeEventListener('scroll', onScroll);
      };
      stop = () => {
        drag.cancel();
      };
    },

    abandon() {
      stop?.();
    },
  };
}
