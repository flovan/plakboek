/**
 * Calls a host's block lifecycle hooks (`*.edit.ts`) at the moments the editor
 * changes mode, selection or markup in the framed site.
 *
 * The order is fixed, because blocks such as a carousel rely on it:
 *
 * - Edit starts (attach in Edit, a switch from Interact, or after a re-render
 *   in Edit): `enter` on every block that has hooks. Attaching in Edit then
 *   applies the current selection (`reveal` on its ancestors, `reveal` and
 *   `select` on it).
 * - Switch to Interact: `leave` on every block that has hooks.
 * - Selection changes: `deselect` on the block that was selected, then `reveal`
 *   on each ancestor with hooks, outermost first, then `reveal` and `select` on
 *   the selected block itself.
 * - A block's element was replaced (a fragment patch, or the development block
 *   swap announced by a blocks-swapped event on the frame document):
 *   `rendered` on it and on every block with hooks inside it, then `enter` in
 *   Edit, then `reveal` and `select` again when the selection lies inside.
 *
 * Every call is contained. A hook that throws is reported once per block type
 * and hook name, with the error's name and nothing from its message (which may
 * hold host data), and never stops the other hooks or the selection.
 *
 * Frame nodes belong to the frame's realm, so no node is tested with
 * `instanceof`.
 */
import {
  EDIT_ATTRIBUTE,
  type BlockEditContext,
  type BlockEditHooks,
  type BlockEditMode,
} from '@plakboek/render';

export type HooksRuntime = {
  /** Binds the runtime to a frame document and starts the Edit lifecycle when
   * the mode is Edit. */
  attach(frameDocument: Document): void;
  setMode(mode: BlockEditMode): void;
  /** The selection moved. `ancestorsOuterFirst` are the selected block's
   * ancestors, outermost first. */
  select(
    selectedId: string | null,
    ancestorsOuterFirst: readonly string[],
  ): void;
  /** These blocks' elements were just replaced. */
  rendered(ids: readonly string[]): void;
  dispose(): void;
};

export type HooksRuntimeOptions = {
  readonly hooks: ReadonlyMap<string, BlockEditHooks>;
  readonly propsOf: (
    id: string,
  ) => Readonly<Record<string, unknown>> | undefined;
  readonly mode: BlockEditMode;
  readonly report?: (message: string) => void;
};

/** Fired on the frame document after the development block swap. */
const SWAPPED_EVENT = 'plakboek:blocks-swapped';

const BLOCK_SELECTOR = `[${EDIT_ATTRIBUTE.block}]`;

type Target = {
  readonly id: string;
  readonly blockType: string;
  readonly element: Element;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function defaultReport(message: string): void {
  // oxlint-disable-next-line no-console -- the documented default report; the editor has no logger and the message is already redacted
  console.warn(message);
}

function errorName(error: unknown): string {
  if (isRecord(error)) {
    const name = error['name'];
    if (typeof name === 'string' && name !== '') return name;
  }
  return 'an error';
}

function escapeAttributeValue(doc: Document, value: string): string {
  const css = doc.defaultView?.CSS;
  return typeof css?.escape === 'function'
    ? css.escape(value)
    : value.replaceAll(/["\\]/g, '\\$&');
}

/** The ids a swap event announced, ignoring anything that is not a string. */
function swappedIds(event: Event): readonly string[] {
  const detail: unknown = Reflect.get(event, 'detail');
  if (!isRecord(detail)) return [];
  const ids = detail['ids'];
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === 'string')
    : [];
}

export function createHooksRuntime(options: HooksRuntimeOptions): HooksRuntime {
  const { hooks, propsOf } = options;
  const report = options.report ?? defaultReport;
  const reported = new Set<string>();

  let doc: Document | null = null;
  let mode: BlockEditMode = options.mode;
  let selectedId: string | null = null;
  let ancestors: readonly string[] = [];
  let stopListening: (() => void) | null = null;

  function guard(blockType: string, hook: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      const key = `${blockType}\u0000${hook}`;
      if (reported.has(key)) return;
      reported.add(key);
      report(
        `[@plakboek/editor] the ${hook} hook of ${blockType} failed: ${errorName(error)}`,
      );
    }
  }

  function contextOf(target: Target, frameDocument: Document) {
    const view = frameDocument.defaultView;
    if (view === null) return null;
    const context: BlockEditContext = {
      id: target.id,
      blockType: target.blockType,
      element: target.element,
      document: frameDocument,
      window: view,
      props: propsOf(target.id) ?? {},
      mode,
    };
    return context;
  }

  function targetOf(element: Element): Target | null {
    const id = element.getAttribute(EDIT_ATTRIBUTE.block);
    const blockType = element.getAttribute(EDIT_ATTRIBUTE.type);
    if (id === null || id === '' || blockType === null) return null;
    return hooks.has(blockType) ? { id, blockType, element } : null;
  }

  function targetById(frameDocument: Document, id: string): Target | null {
    const element = frameDocument.querySelector(
      `[${EDIT_ATTRIBUTE.block}="${escapeAttributeValue(frameDocument, id)}"]`,
    );
    return element === null ? null : targetOf(element);
  }

  function hookedIn(root: ParentNode): Target[] {
    const found: Target[] = [];
    for (const element of root.querySelectorAll(BLOCK_SELECTOR)) {
      const target = targetOf(element);
      if (target !== null) found.push(target);
    }
    return found;
  }

  function call(
    name: 'enter' | 'leave' | 'select' | 'deselect' | 'rendered',
    target: Target,
    frameDocument: Document,
  ): void {
    const hook = hooks.get(target.blockType)?.[name];
    if (hook === undefined) return;
    const context = contextOf(target, frameDocument);
    if (context === null) return;
    guard(target.blockType, name, () => {
      hook(context);
    });
  }

  function callReveal(
    target: Target,
    targetId: string,
    frameDocument: Document,
  ): void {
    const hook = hooks.get(target.blockType)?.reveal;
    if (hook === undefined) return;
    const context = contextOf(target, frameDocument);
    if (context === null) return;
    guard(target.blockType, 'reveal', () => {
      hook({ ...context, targetId });
    });
  }

  /** reveal on each ancestor with hooks, outermost first, then on the block
   * itself, then select. */
  function applySelection(frameDocument: Document): void {
    if (selectedId === null) return;
    const id = selectedId;
    for (const ancestorId of ancestors) {
      const target = targetById(frameDocument, ancestorId);
      if (target !== null) callReveal(target, id, frameDocument);
    }
    const item = targetById(frameDocument, id);
    if (item === null) return;
    callReveal(item, id, frameDocument);
    call('select', item, frameDocument);
  }

  function enterAll(frameDocument: Document): void {
    for (const target of hookedIn(frameDocument)) {
      call('enter', target, frameDocument);
    }
  }

  function rendered(ids: readonly string[]): void {
    const frameDocument = doc;
    if (frameDocument === null) return;
    const targets = new Map<Element, Target>();
    const touchedIds = new Set<string>();
    for (const id of ids) {
      const element = frameDocument.querySelector(
        `[${EDIT_ATTRIBUTE.block}="${escapeAttributeValue(frameDocument, id)}"]`,
      );
      if (element === null) continue;
      touchedIds.add(id);
      for (const nested of element.querySelectorAll(BLOCK_SELECTOR)) {
        const nestedId = nested.getAttribute(EDIT_ATTRIBUTE.block);
        if (nestedId !== null) touchedIds.add(nestedId);
      }
      const own = targetOf(element);
      if (own !== null) targets.set(element, own);
      for (const target of hookedIn(element)) {
        targets.set(target.element, target);
      }
    }
    for (const target of targets.values()) {
      call('rendered', target, frameDocument);
    }
    if (mode === 'edit') {
      for (const target of targets.values()) {
        call('enter', target, frameDocument);
      }
    }
    if (selectedId !== null && touchedIds.has(selectedId)) {
      applySelection(frameDocument);
    }
  }

  return {
    attach(frameDocument) {
      stopListening?.();
      doc = frameDocument;
      const listener = (event: Event): void => {
        rendered(swappedIds(event));
      };
      frameDocument.addEventListener(SWAPPED_EVENT, listener);
      stopListening = () => {
        frameDocument.removeEventListener(SWAPPED_EVENT, listener);
      };
      if (mode === 'edit') {
        enterAll(frameDocument);
        // A new document (a reload, or modules that loaded after the selection
        // was made) shows the selection's slide or panel again.
        applySelection(frameDocument);
      }
    },

    setMode(next) {
      if (next === mode) return;
      mode = next;
      const frameDocument = doc;
      if (frameDocument === null) return;
      if (next === 'interact') {
        for (const target of hookedIn(frameDocument)) {
          call('leave', target, frameDocument);
        }
      } else {
        enterAll(frameDocument);
      }
    },

    select(nextId, ancestorsOuterFirst) {
      const previousId = selectedId;
      selectedId = nextId;
      ancestors = ancestorsOuterFirst;
      const frameDocument = doc;
      if (frameDocument === null) return;
      if (previousId !== null) {
        const previous = targetById(frameDocument, previousId);
        if (previous !== null) call('deselect', previous, frameDocument);
      }
      applySelection(frameDocument);
    },

    rendered,

    dispose() {
      stopListening?.();
      stopListening = null;
      doc = null;
    },
  };
}
