/**
 * The tab stops Tab routing moves between: the controls of the in-frame chrome
 * that sit in the tab order, and the shell control that follows the stage.
 * Nodes come from two documents, so they are recognised by shape.
 */
import { isFocusable } from '../chrome-host/shape.js';

const DIALOG = '[role="dialog"], [role="alertdialog"]';

/** Whether the element is drawn: a control that is not cannot take focus. */
function isShown(element: HTMLElement): boolean {
  const check: unknown = Reflect.get(element, 'checkVisibility');
  return typeof check === 'function'
    ? Reflect.apply(check, element, [
        { checkVisibilityCSS: true, visibilityProperty: true },
      ]) === true
    : element.getClientRects().length > 0;
}

/** The tabbable controls of a root, in document order; those inside a dialog keep the dialog's own focus handling. */
export function tabStops(root: ParentNode): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const candidate of root.querySelectorAll(
    'button, a[href], [tabindex]',
  )) {
    if (!isFocusable(candidate)) continue;
    if (candidate.tabIndex < 0) continue;
    if (Reflect.get(candidate, 'disabled') === true) continue;
    if (candidate.closest(DIALOG) !== null) continue;
    if (!isShown(candidate)) continue;
    found.push(candidate);
  }
  return found;
}

/**
 * The tab stop of the shell that follows the stage in document order, else the
 * first one (a shell where nothing follows the stage wraps rather than trap).
 */
export function stopAfterStage(
  shellRoot: ParentNode,
  stage: Element,
): HTMLElement | null {
  const all = tabStops(shellRoot);
  const following = all.find(
    (candidate) =>
      candidate !== stage &&
      (stage.compareDocumentPosition(candidate) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
        0,
  );
  return following ?? all.find((candidate) => candidate !== stage) ?? null;
}
