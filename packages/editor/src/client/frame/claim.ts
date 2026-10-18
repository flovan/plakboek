/**
 * The Edit-mode claim on the framed site's events.
 *
 * In Edit mode a click must select a block, not follow a link, toggle an
 * accordion or submit a form. The claim is one capture-phase listener per
 * event type on the frame's window; each one cancels the event's default and
 * stops it before any site listener on an element, the body or the document
 * sees it. `stopImmediatePropagation` also beats window-capture listeners that
 * are registered after the claim, so the claim is attached as early as the
 * frame allows.
 *
 * Limit (measured in the phase spike): a site listener registered on the same
 * window in the capture phase before the claim still runs first, because site
 * scripts load before the frame's `load` event. Hosts must not capture-listen
 * on `window` for clicks.
 *
 * The shell's link-follow listener runs in the bubble phase and never sees a
 * claimed click, so a link in Edit mode selects its block and goes nowhere.
 * Detaching removes every listener with the options it was added with, which
 * gives the site its own behaviour back exactly.
 */

/** Every event the claim takes. Cancelling `pointerdown` already suppresses
 * the compatibility mouse events in a browser; the rest are belt and braces. */
export const CLAIMED_EVENTS = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'submit',
  'dragstart',
  'selectstart',
] as const;

export type ClaimHandlers = {
  /** A click, in the frame's own coordinates. */
  readonly onClick: (x: number, y: number) => void;
  /** A double-click, in the frame's own coordinates. */
  readonly onDoubleClick: (x: number, y: number) => void;
};

/** Duck-typed so an event from the frame's realm needs no `instanceof`. */
function pointerPosition(event: Event): { x: number; y: number } {
  const x: unknown = Reflect.get(event, 'clientX');
  const y: unknown = Reflect.get(event, 'clientY');
  return {
    x: typeof x === 'number' ? x : 0,
    y: typeof y === 'number' ? y : 0,
  };
}

/**
 * Claims the events on `frameWindow`. Returns the function that releases them.
 */
export function attachClaim(
  frameWindow: Window,
  handlers: ClaimHandlers,
): () => void {
  const listener = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (event.type === 'click') {
      const { x, y } = pointerPosition(event);
      handlers.onClick(x, y);
    } else if (event.type === 'dblclick') {
      const { x, y } = pointerPosition(event);
      handlers.onDoubleClick(x, y);
    }
  };
  for (const type of CLAIMED_EVENTS) {
    frameWindow.addEventListener(type, listener, { capture: true });
  }
  return () => {
    for (const type of CLAIMED_EVENTS) {
      frameWindow.removeEventListener(type, listener, { capture: true });
    }
  };
}
