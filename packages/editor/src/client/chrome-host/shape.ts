/**
 * Chrome that lives in the frame document handles nodes of two realms: the
 * shell's and the frame's. A frame node is never an `instanceof` the shell's
 * `Node`, `Element`, `ShadowRoot` or `Document`, so these checks look at what a
 * value is made of instead.
 */

/** Anything with a node type: a node of either realm. */
export function isNodeLike(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'nodeType') === 'number'
  );
}

/** A node that can be searched and listened to: a document or a shadow root. */
export type SearchableRoot = Node & ParentNode & EventTarget;

/** The root a node sits in (a shadow root or a document), or null. */
export function rootOfNode(
  node: Node | null | undefined,
): SearchableRoot | null {
  if (node === null || node === undefined) return null;
  const root: unknown = node.getRootNode();
  if (
    typeof root === 'object' &&
    root !== null &&
    typeof Reflect.get(root, 'querySelector') === 'function' &&
    typeof Reflect.get(root, 'addEventListener') === 'function'
  ) {
    return root as SearchableRoot;
  }
  return null;
}

/** An element that can take focus, of either realm. */
export function isFocusable(value: unknown): value is HTMLElement {
  return (
    isNodeLike(value) &&
    typeof Reflect.get(value, 'focus') === 'function' &&
    typeof Reflect.get(value, 'tagName') === 'string'
  );
}

/** The `<iframe>` element a node's document is shown in, or null. */
export function frameElementOf(
  node: Node | null | undefined,
): HTMLIFrameElement | null {
  const view = node?.ownerDocument?.defaultView ?? null;
  const frame: unknown = view === null ? null : view.frameElement;
  if (
    isNodeLike(frame) &&
    Reflect.get(frame, 'tagName') === 'IFRAME' &&
    typeof Reflect.get(frame, 'getBoundingClientRect') === 'function'
  ) {
    return frame as HTMLIFrameElement;
  }
  return null;
}

/** Where the frame's content box starts in the shell's viewport. */
export function frameOriginOf(frame: HTMLIFrameElement): {
  readonly x: number;
  readonly y: number;
} {
  const rect = frame.getBoundingClientRect();
  return { x: rect.left + frame.clientLeft, y: rect.top + frame.clientTop };
}
