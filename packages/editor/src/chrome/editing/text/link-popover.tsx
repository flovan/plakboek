import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { Editor } from '@tiptap/core';
import type { LinkTarget } from '@plakboek/content/rich-text';
import type { Box } from '../../../client/overlay/geometry.js';
import { slashPlacement } from '../../../client/overlay/slot-geometry.js';
import type { EditorStore } from '../../../client/session/store.js';
import type { TextController } from '../../../client/text/controller.js';
import {
  linkContext,
  linkTransaction,
  unlinkTransaction,
} from '../../../client/text/link.js';
import { STRINGS } from '../../strings.js';
import { LinkTargetEditor } from './link-target-editor.js';

export type LinkPopoverProps = {
  readonly controller: TextController;
  readonly store: EditorStore;
  /** The part of the document the frame shows, in the framed document's coordinates. */
  readonly visible: Box;
};

/** The tallest the popover grows: the page list scrolls inside it past this. */
const POPOVER_MAX_HEIGHT = 480;

const BUTTON =
  'h-10 flex-1 cursor-pointer rounded-lg border px-3 text-body font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

/** Whether a node on an event's path is the toolbar's Link button, whichever window made it. */
function isLinkButton(node: EventTarget): boolean {
  const element = node as Partial<Element>;
  return (
    typeof element.hasAttribute === 'function' &&
    element.hasAttribute('data-link-button')
  );
}

/** The selection's box in the framed document's coordinates, or null when the editor is gone. */
function selectionBox(editor: Editor, from: number, to: number): Box | null {
  try {
    const { view } = editor;
    const owner = view.dom.ownerDocument.defaultView;
    const scrollX = owner?.scrollX ?? 0;
    const scrollY = owner?.scrollY ?? 0;
    const start = view.coordsAtPos(from);
    const end = view.coordsAtPos(to);
    const left = Math.min(start.left, end.left);
    const top = Math.min(start.top, end.top);
    return {
      left: left + scrollX,
      top: top + scrollY,
      width: Math.max(0, Math.max(start.right, end.right) - left),
      height: Math.max(start.bottom, end.bottom) - top,
    };
  } catch {
    // The view is mid-teardown; the popover goes with it.
    return null;
  }
}

/**
 * The link popover: a 320px non-modal dialog hung below the selection (above
 * it when there is more room there, 8px inside the frame). It works on the
 * place the selection was when it opened: over the selection, over the link
 * the caret touches, or, at a bare caret, as new text. Apply and Remove put
 * the focus back in the field; Escape and a press anywhere else close it
 * without a change.
 */
export function LinkPopover(props: LinkPopoverProps): ReactElement | null {
  const { controller, store, visible } = props;
  const root = useRef<HTMLDivElement>(null);
  const [context] = useState(() => {
    const editor = controller.editor();
    return editor === null ? null : linkContext(editor.state);
  });
  const [target, setTarget] = useState<LinkTarget | null>(
    context?.kind === 'edit' ? context.target : null,
  );

  // Escape closes the popover and nothing else, wherever the focus is; a press
  // anywhere but here or on the Link button closes it as well.
  useEffect(() => {
    const element = root.current;
    if (element === null) return undefined;
    const owner = element.ownerDocument;
    const onKey = (event: KeyboardEvent): void => {
      if (
        event.key !== 'Escape' ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      controller.closeLink();
      controller.focusField();
    };
    const onPress = (event: Event): void => {
      const path = event.composedPath();
      if (path.includes(element) || path.some((node) => isLinkButton(node))) {
        return;
      }
      controller.closeLink();
    };
    owner.addEventListener('keydown', onKey, true);
    owner.addEventListener('pointerdown', onPress, true);
    return () => {
      owner.removeEventListener('keydown', onKey, true);
      owner.removeEventListener('pointerdown', onPress, true);
    };
  }, [controller]);

  const editor = controller.editor();
  if (editor === null || context === null) return null;
  const anchor = selectionBox(editor, context.from, context.to);
  if (anchor === null) return null;
  const placement = slashPlacement(anchor, visible, POPOVER_MAX_HEIGHT);

  const finish = (announcement: string): void => {
    controller.closeLink();
    controller.focusField();
    store.announce(announcement);
  };

  const apply = (): void => {
    if (target === null) return;
    const tr = linkTransaction(editor.state, context, target, null);
    if (tr === null) return;
    editor.view.dispatch(tr);
    finish(
      STRINGS[
        context.kind === 'edit'
          ? 'text.announce.linkUpdated'
          : 'text.announce.linkAdded'
      ],
    );
  };

  const remove = (): void => {
    const tr = unlinkTransaction(editor.state, context);
    if (tr === null) return;
    editor.view.dispatch(tr);
    finish(STRINGS['text.announce.linkRemoved']);
  };

  return (
    <div
      ref={root}
      role="dialog"
      aria-label={STRINGS['text.linkPopover.label']}
      className="pk-link-popover"
      data-link-popover=""
      data-side={placement.side}
      style={{
        left: placement.left,
        top: placement.top,
        maxHeight: placement.maxHeight,
        transform: placement.side === 'above' ? 'translateY(-100%)' : undefined,
      }}
    >
      <LinkTargetEditor value={target} onChange={setTarget} onSubmit={apply} />
      <div className="flex gap-2 pt-2">
        {context.kind === 'edit' ? (
          <button
            type="button"
            className={`${BUTTON} border-control-border bg-surface text-text hover:bg-surface-muted`}
            onClick={remove}
          >
            {STRINGS['text.link.remove']}
          </button>
        ) : null}
        <button
          type="button"
          aria-disabled={target === null}
          className={`${BUTTON} border-transparent bg-accent text-accent-contrast aria-disabled:cursor-default aria-disabled:opacity-60`}
          onClick={apply}
        >
          {STRINGS['text.link.apply']}
        </button>
      </div>
    </div>
  );
}
