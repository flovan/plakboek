import { EDIT_ATTRIBUTE } from '@plakboek/render';
import { applyPatchSteps, domViewOf } from './client/frame/patch.js';
import { planPatch } from './client/frame/patch-plan.js';

/**
 * Development-only block swap, loaded by the core dev client. When a block's
 * source changes, the server re-renders the page; this finds which blocks'
 * own markup differs between two renders and swaps just those through the
 * editor's fragment patcher (same inline-edit guard, same scroll restore).
 * A change in which blocks exist or how they nest reloads the page instead.
 *
 * Framework-free on purpose: no React, no server module, none of the editor
 * chrome. The page being developed is not an editor session.
 */

const BLOCK_SELECTOR = `[${EDIT_ATTRIBUTE.block}]`;

const BLOCKS_SWAPPED_EVENT = 'plakboek:blocks-swapped';

/** A block's parent block (null at the top) and its own markup, with the
 * blocks nested in it stood in by placeholders. */
export type SignatureMap = ReadonlyMap<
  string,
  { readonly parentId: string | null; readonly own: string }
>;

function isElementNode(node: Node): node is Element {
  return node.nodeType === 1;
}

function ownMarkup(element: Element): string {
  const clone = element.cloneNode(true);
  if (!isElementNode(clone)) return element.outerHTML;
  for (const nested of clone.querySelectorAll(BLOCK_SELECTOR)) {
    const id = nested.getAttribute(EDIT_ATTRIBUTE.block) ?? '';
    nested.replaceWith(clone.ownerDocument.createComment(`pk:${id}`));
  }
  return clone.outerHTML;
}

/** Every block in a document, by id. */
export function readSignatures(root: ParentNode): SignatureMap {
  const signatures = new Map<
    string,
    { parentId: string | null; own: string }
  >();
  for (const element of root.querySelectorAll(BLOCK_SELECTOR)) {
    const id = element.getAttribute(EDIT_ATTRIBUTE.block);
    if (id === null) continue;
    const parent = element.parentElement?.closest(BLOCK_SELECTOR) ?? null;
    signatures.set(id, {
      parentId: parent?.getAttribute(EDIT_ATTRIBUTE.block) ?? null,
      own: ownMarkup(element),
    });
  }
  return signatures;
}

/**
 * What changed between two renders. `structural` when a block was added,
 * removed or moved under another parent; the page should reload and `changed`
 * is empty. Otherwise `changed` holds the outermost blocks whose own markup
 * differs (a changed block inside a changed block is carried by the outer one).
 */
export function diffSignatures(
  before: SignatureMap,
  after: SignatureMap,
): { readonly changed: readonly string[]; readonly structural: boolean } {
  if (before.size !== after.size) return { changed: [], structural: true };
  for (const [id, signature] of after) {
    const previous = before.get(id);
    if (previous === undefined || previous.parentId !== signature.parentId)
      return { changed: [], structural: true };
  }

  const differing = new Set<string>();
  for (const [id, signature] of after) {
    if (before.get(id)?.own !== signature.own) differing.add(id);
  }

  const changed = [...differing].filter((id) => {
    let parentId = after.get(id)?.parentId ?? null;
    while (parentId !== null) {
      if (differing.has(parentId)) return false;
      parentId = after.get(parentId)?.parentId ?? null;
    }
    return true;
  });
  return { changed, structural: false };
}

type DevBlockSwapOptions = {
  readonly document: Document;
  /** The page's address, fetched again for every swap. */
  readonly url: string;
  /** Replaces `fetch`, for tests. Returns the page's HTML. */
  readonly fetchHtml?: (url: string) => Promise<string>;
};

type DevBlockSwapResult = {
  readonly swapped: readonly string[];
  readonly reloaded: boolean;
  /** Changed blocks held back because one is being edited in place; the next
   * swap tries them again. */
  readonly deferred: readonly string[];
};

type DevBlockSwap = {
  /** Resolves once the baseline render is stored. */
  readonly ready: Promise<void>;
  swap(): Promise<DevBlockSwapResult>;
};

async function fetchPageHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { Accept: 'text/html' },
  });
  if (!response.ok) throw new Error(`page request failed: ${response.status}`);
  return await response.text();
}

export function createDevBlockSwap(options: DevBlockSwapOptions): DevBlockSwap {
  const { document, url } = options;
  const fetchHtml = options.fetchHtml ?? fetchPageHtml;
  const view = document.defaultView;
  const ParserConstructor = view?.DOMParser ?? DOMParser;
  const EventConstructor = view?.CustomEvent ?? CustomEvent;
  const parse = (html: string): Document =>
    new ParserConstructor().parseFromString(html, 'text/html');

  let baseline = new Map<
    string,
    { readonly parentId: string | null; readonly own: string }
  >();

  const ready = fetchHtml(url).then((html) => {
    baseline = new Map(readSignatures(parse(html)));
  });
  // A failed baseline is handled by the first swap (a reload); the rejection
  // stays visible to whoever awaits `ready`.
  ready.catch(() => undefined);

  const reload = (): DevBlockSwapResult => {
    view?.location.reload();
    return { swapped: [], reloaded: true, deferred: [] };
  };

  async function run(): Promise<DevBlockSwapResult> {
    try {
      await ready;
      const fresh = parse(await fetchHtml(url));
      const after = readSignatures(fresh);
      const { changed, structural } = diffSignatures(baseline, after);
      if (structural) return reload();
      if (changed.length === 0)
        return { swapped: [], reloaded: false, deferred: [] };

      const elements = new Map<string, Element>();
      for (const element of fresh.querySelectorAll(BLOCK_SELECTOR)) {
        const id = element.getAttribute(EDIT_ATTRIBUTE.block);
        if (id !== null) elements.set(id, element);
      }
      const fragments = changed.flatMap((id) => {
        const element = elements.get(id);
        return element === undefined ? [] : [{ id, html: element.outerHTML }];
      });
      const plan = planPatch(
        { fragments, removed: [], rootOrder: null },
        domViewOf(document),
      );
      const result = applyPatchSteps(document, plan.steps);
      if (result.reloadNeeded) return reload();

      // A swapped block carries its whole subtree, so the baseline moves for
      // it and everything inside; a deferred block keeps its old baseline.
      const swapped = new Set(result.replaced);
      for (const [id, signature] of after) {
        let current: string | null = id;
        while (current !== null && !swapped.has(current))
          current = after.get(current)?.parentId ?? null;
        if (current !== null) baseline.set(id, signature);
      }

      if (result.replaced.length > 0)
        document.dispatchEvent(
          new EventConstructor(BLOCKS_SWAPPED_EVENT, {
            detail: { ids: result.replaced },
          }),
        );
      return {
        swapped: result.replaced,
        reloaded: false,
        deferred: [...plan.deferred.keys()],
      };
    } catch {
      // The server is restarting or the render failed: the old behaviour.
      return reload();
    }
  }

  let queue: Promise<unknown> = Promise.resolve();
  return {
    ready,
    swap: () => {
      const next = queue.then(run);
      queue = next;
      return next;
    },
  };
}
