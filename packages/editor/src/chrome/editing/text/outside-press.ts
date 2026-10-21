import { useEffect, useRef, type RefObject } from 'react';
import { isNodeLike, rootOfNode } from '../../../client/chrome-host/shape.js';

export type OutsidePressOptions = {
  /** Listen only while true; a menu passes whether it is open. Default true. */
  readonly enabled?: boolean;
  /** A node of the event path that also counts as inside, such as the button that toggles the popover. */
  readonly alsoInside?: (node: EventTarget) => boolean;
};

/**
 * Calls `onOutside` for a pointer press outside `element`, which sits in the
 * chrome's shadow root inside the framed document.
 *
 * A listener on the framed document cannot decide this alone: the chrome root
 * is closed (D-14), and for a listener outside a closed tree the composed path
 * of a press inside it stops at the host element, so every inside press would
 * look like an outside one. A listener on the root the element sits in sees the
 * whole path in either shadow mode, so presses in the chrome are decided there
 * and the document listener decides only the presses that came from the page.
 * `hadFocus` says whether the focus was inside the element, read from the
 * element's own root, because inside a shadow root the focused element is that
 * root's and not the document's.
 */
export function useOutsidePress(
  element: RefObject<HTMLElement | null>,
  onOutside: (event: Event, hadFocus: boolean) => void,
  options: OutsidePressOptions = {},
): void {
  const { enabled = true } = options;
  const latest = useRef({ onOutside, alsoInside: options.alsoInside });
  latest.current = { onOutside, alsoInside: options.alsoInside };

  useEffect(() => {
    const target = element.current;
    if (!enabled || target === null) return undefined;
    const owner = target.ownerDocument;
    const root = rootOfNode(target);
    const shadow = root !== null && root !== (owner as Node) ? root : null;
    const host: unknown = shadow === null ? null : Reflect.get(shadow, 'host');

    const isInside = (event: Event): boolean => {
      const path = event.composedPath();
      const { alsoInside } = latest.current;
      return (
        path.includes(target) ||
        (alsoInside !== undefined && path.some((node) => alsoInside(node)))
      );
    };
    const hadFocus = (): boolean => {
      const rootNode = target.getRootNode() as Document | ShadowRoot;
      const active: unknown = rootNode.activeElement;
      return isNodeLike(active) && target.contains(active);
    };
    const decide = (event: Event): void => {
      if (isInside(event)) return;
      latest.current.onOutside(event, hadFocus());
    };
    // A press inside the chrome root reaches the document retargeted to the
    // host; the root's own listener decides it.
    const onDocument = (event: Event): void => {
      if (host !== null && event.target === host) return;
      decide(event);
    };

    owner.addEventListener('pointerdown', onDocument, true);
    shadow?.addEventListener('pointerdown', decide, true);
    return () => {
      owner.removeEventListener('pointerdown', onDocument, true);
      shadow?.removeEventListener('pointerdown', decide, true);
    };
  }, [element, enabled]);
}
