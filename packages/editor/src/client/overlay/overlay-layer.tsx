import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { formatString } from '../../chrome/strings.js';
import {
  chipPlacement,
  outlineRect,
  type Box,
  type ChipPlacement,
} from './geometry.js';
import { createHoverTracker, type HoverState } from './tracker.js';

function boxStyle(box: Box): CSSProperties {
  return {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
  };
}

/** The chip's text: the editor label, with " (unavailable)" after it for a
 * block that renders nothing. */
export function chipText(state: {
  readonly label: string;
  readonly unavailable: boolean;
}): string {
  return state.unavailable
    ? formatString('overlay.unavailable', { type: state.label })
    : state.label;
}

/**
 * The hover overlay: an outline, a dashed outline for the section around it
 * and a label chip, drawn over the framed site.
 *
 * It is a layer of the shell, exactly over the frame's content box and
 * clipped to it, so everything it draws lives in the shell's shadow root and
 * the site's document is never touched. The layer does not take part in
 * pointer or keyboard interaction (`pointer-events: none`, `aria-hidden`);
 * hover is read from the frame by the tracker. Inside the clip, an
 * unclipped plane starts at the shell's origin, so boxes are placed with the
 * shell's own coordinates.
 *
 * The frame is looked up in the shadow root the layer sits in, unless one is
 * passed.
 */
export function OverlayLayer(props: {
  readonly frame?: HTMLIFrameElement | null;
}): ReactElement {
  const { frame } = props;
  const layer = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<HoverState | null>(null);

  useEffect(() => {
    const root = layer.current?.getRootNode();
    const target =
      frame ??
      (root instanceof ShadowRoot || root instanceof Document
        ? root.querySelector('iframe')
        : null);
    if (!(target instanceof HTMLIFrameElement)) return undefined;
    const tracker = createHoverTracker(target, setState);
    return () => {
      tracker.dispose();
    };
  }, [frame]);

  let drawn: {
    readonly outline: Box;
    readonly section: Box | null;
    readonly chip: ChipPlacement;
  } | null = null;
  if (state !== null) {
    const origin = { x: state.frame.left, y: state.frame.top };
    const outline = outlineRect(state.element, origin);
    drawn = {
      outline,
      section:
        state.section === null ? null : outlineRect(state.section, origin),
      chip: chipPlacement({ outline, frame: state.frame }),
    };
  }

  return (
    <div
      ref={layer}
      className="pk-overlay"
      aria-hidden="true"
      data-overlay=""
      style={state === null ? undefined : boxStyle(state.frame)}
    >
      {state !== null && drawn !== null ? (
        <div
          className="pk-overlay-plane"
          style={{ left: -state.frame.left, top: -state.frame.top }}
        >
          {drawn.section === null ? null : (
            <div
              className="pk-overlay-section"
              data-overlay-section=""
              style={boxStyle(drawn.section)}
            />
          )}
          <div
            key={state.blockId}
            className="pk-overlay-target"
            data-overlay-target={state.blockId}
          >
            <div
              className="pk-overlay-outline"
              data-overlay-outline=""
              style={boxStyle(drawn.outline)}
            />
            {drawn.chip.mode === 'hidden' ? null : (
              <div
                className="pk-overlay-chip"
                data-overlay-chip=""
                data-placement={drawn.chip.mode}
                style={{ left: drawn.chip.left, top: drawn.chip.top }}
              >
                {chipText(state)}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
