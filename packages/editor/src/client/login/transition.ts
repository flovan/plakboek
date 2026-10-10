/**
 * The hand-over from the login card to the edit shell (S2). A correct sign-in
 * does not reload into a blank screen: the page behind the card is still
 * there, so it unblurs, the real frame shrinks to the right into the place
 * the shell will paint it, and the sidebar slides in from the left. Then the
 * editor flag is set and the browser opens `<page>?_edit=1`, whose first
 * paint is the same picture.
 *
 * The frame is animated by its real size and position, never by a scale: the
 * site stays at 1:1 the whole way (D-28), so what the editor sees at the end
 * is what the shell shows. That is a layout animation, accepted for a
 * 480ms hand-over. The target is the rectangle the shell's CSS gives the
 * frame, computed from the layout the editor last chose, which lives in
 * `localStorage` under `plakboek:editor-layout` and is read at the moment the
 * transition starts.
 */
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { EDITOR_FLAG_KEY } from '@plakboek/render';
import type { SidebarLayout } from '../../chrome/controls.js';
import {
  TransitionChrome,
  type PixelRect,
} from '../../chrome/login/transition-chrome.js';
import { applyLayout, readLayout } from '../shell/layout.js';

/** The width of the sidebar and of the rail, as the shell's CSS has them. */
const SIDEBAR_WIDTH = 280;
const RAIL_WIDTH = 56;

/** The stage padding around a framed site. */
const STAGE_PADDING = 24;

/** The easing of every movement; opacity-only changes use `ease-out`. */
const EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** How long after the last frame a navigation that has not committed shows
 * the opening spinner. */
const SLOW_RESPONSE_MS = 400;

/** The S2 sequence: offset and duration of each part, in milliseconds. */
export const TIMINGS = Object.freeze({
  card: { delay: 0, duration: 160 },
  unblur: { delay: 80, duration: 320 },
  frame: { delay: 120, duration: 480 },
  sidebar: { delay: 240, duration: 320 },
});

/**
 * Where the shell puts the frame in a viewport, as the border box of the
 * iframe: framed leaves the sidebar and 24px of stage on every side, full
 * leaves the rail and nothing else. This must agree with the shell's
 * stylesheet; an end-to-end test compares the two on screen.
 */
export function targetFrameRect(
  layout: SidebarLayout,
  viewport: { readonly width: number; readonly height: number },
): PixelRect {
  if (layout === 'full') {
    return {
      left: RAIL_WIDTH,
      top: 0,
      width: viewport.width - RAIL_WIDTH,
      height: viewport.height,
    };
  }
  return {
    left: SIDEBAR_WIDTH + STAGE_PADDING,
    top: STAGE_PADDING,
    width: viewport.width - SIDEBAR_WIDTH - 2 * STAGE_PADDING,
    height: viewport.height - 2 * STAGE_PADDING,
  };
}

/** The address of the page in edit mode: `_edit=1` added to the query, and
 * kept before any fragment. */
export function editAddress(next: string): string {
  const hash = next.indexOf('#');
  const path = hash === -1 ? next : next.slice(0, hash);
  const fragment = hash === -1 ? '' : next.slice(hash);
  return `${path}${path.includes('?') ? '&' : '?'}_edit=1${fragment}`;
}

export type LoginTransitionInput = {
  readonly host: HTMLElement;
  readonly shadowRoot: ShadowRoot;
  /** The page behind the card and the page to open. */
  readonly next: string;
  readonly user: { readonly name: string; readonly email: string };
  /** Skip every animation and open the page at once. */
  readonly reducedMotion: boolean;
  /** Called when the dialog stops being modal, so nothing reopens it. */
  readonly onLeaving?: () => void;
  /** Opens the edit page. Replaced in tests; the default navigates. */
  readonly navigate?: (address: string) => void;
};

function rememberEditor(): void {
  try {
    globalThis.localStorage.setItem(EDITOR_FLAG_KEY, '1');
  } catch {
    // Storage is blocked: the Edit pill will not show, and nothing else changes.
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
}

/**
 * Runs the hand-over and then opens `next` in edit mode. It resolves once the
 * navigation has been requested; the page is replaced after that.
 */
export async function runLoginTransition(
  input: LoginTransitionInput,
): Promise<void> {
  const { host, shadowRoot, next, user, reducedMotion } = input;
  const navigate =
    input.navigate ??
    ((address: string) => {
      globalThis.location.assign(address);
    });
  const iframe = shadowRoot.querySelector<HTMLIFrameElement>('iframe');
  const dialog = shadowRoot.querySelector<HTMLDialogElement>('dialog');
  const card = shadowRoot.querySelector<HTMLElement>('.pk-card');
  if (iframe === null || dialog === null || card === null) {
    // Nothing to animate: just open the page.
    rememberEditor();
    navigate(editAddress(next));
    return;
  }

  const layout = readLayout();
  applyLayout(host, layout);
  const viewport = host.getBoundingClientRect();
  const target = targetFrameRect(layout, viewport);

  // The card stops being a modal so the sidebar can be seen through its
  // scrim; the dialog stays open, in place, as the scrim.
  input.onLeaving?.();
  dialog.close();
  dialog.show();

  const container = document.createElement('div');
  shadowRoot.append(container);
  const root = createRoot(container);
  const draw = (openingIn: PixelRect | null): void => {
    flushSync(() => {
      root.render(
        createElement(TransitionChrome, { user, next, layout, openingIn }),
      );
    });
  };
  draw(null);
  const sidebar = container.querySelector<HTMLElement>('.pk-login-sidebar');

  iframe.classList.add('pk-backdrop-leaving');
  const appearance = getComputedStyle(iframe);
  const finalAppearance = {
    borderWidth: appearance.borderTopWidth,
    borderRadius: appearance.borderTopLeftRadius,
    boxShadow: appearance.boxShadow,
  };

  if (reducedMotion) {
    // No movement at all: the shell state appears at once.
    iframe.style.left = `${target.left}px`;
    iframe.style.top = `${target.top}px`;
    iframe.style.width = `${target.width}px`;
    iframe.style.height = `${target.height}px`;
    iframe.style.filter = 'none';
    dialog.close();
  } else {
    const fill = 'both' as const;
    const animations = [
      card.animate(
        [
          { opacity: 1, transform: 'scale(1)' },
          { opacity: 0, transform: 'scale(0.98)' },
        ],
        { ...TIMINGS.card, easing: 'ease-out', fill },
      ),
      dialog.animate(
        [
          { backgroundColor: getComputedStyle(dialog).backgroundColor },
          { backgroundColor: 'rgba(0, 0, 0, 0)' },
        ],
        { ...TIMINGS.unblur, easing: EASING, fill },
      ),
      iframe.animate([{ filter: 'blur(12px)' }, { filter: 'blur(0px)' }], {
        ...TIMINGS.unblur,
        easing: EASING,
        fill,
      }),
      iframe.animate(
        [
          {
            left: '0px',
            top: '0px',
            width: `${viewport.width}px`,
            height: `${viewport.height}px`,
          },
          {
            left: `${target.left}px`,
            top: `${target.top}px`,
            width: `${target.width}px`,
            height: `${target.height}px`,
          },
        ],
        { ...TIMINGS.frame, easing: EASING, fill },
      ),
      // The frame's border, radius and shadow come in with the shrink, to the
      // values the class gives them (none at all in the full layout).
      iframe.animate(
        [
          { borderWidth: '0px', borderRadius: '0px', boxShadow: 'none' },
          finalAppearance,
        ],
        { ...TIMINGS.frame, easing: EASING, fill },
      ),
    ];
    if (sidebar !== null) {
      const from = layout === 'full' ? -RAIL_WIDTH : -SIDEBAR_WIDTH;
      animations.push(
        sidebar.animate(
          [
            { transform: `translateX(${from}px)`, opacity: 0 },
            { transform: 'translateX(0)', opacity: 1 },
          ],
          { ...TIMINGS.sidebar, easing: EASING, fill },
        ),
      );
    }
    await Promise.allSettled(animations.map((animation) => animation.finished));
    await nextFrame();
  }

  rememberEditor();
  // A page that has not started to answer shows a spinner where the frame is.
  globalThis.setTimeout(() => {
    draw(target);
  }, SLOW_RESPONSE_MS);
  navigate(editAddress(next));
}
