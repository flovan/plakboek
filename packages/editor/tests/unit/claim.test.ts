import { describe, expect, it, vi } from 'vitest';
import { attachClaim, CLAIMED_EVENTS } from '../../src/client/frame/claim.js';

type Listener = (event: Event) => void;

function fakeWindow() {
  const added: { type: string; listener: Listener; capture: boolean }[] = [];
  const removed: { type: string; listener: Listener; capture: boolean }[] = [];
  const frameWindow = {
    addEventListener(
      type: string,
      listener: Listener,
      options: { capture: boolean },
    ) {
      added.push({ type, listener, capture: options.capture });
    },
    removeEventListener(
      type: string,
      listener: Listener,
      options: { capture: boolean },
    ) {
      removed.push({ type, listener, capture: options.capture });
    },
  };
  // The claim only calls the two methods above.
  return { added, removed, frameWindow: frameWindow as unknown as Window };
}

function fakeEvent(type: string, x = 0, y = 0) {
  const event = {
    type,
    clientX: x,
    clientY: y,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    stopImmediatePropagation: vi.fn(),
  };
  return event;
}

function handlers() {
  return { onClick: vi.fn(), onDoubleClick: vi.fn() };
}

function dispatch(
  added: ReturnType<typeof fakeWindow>['added'],
  event: ReturnType<typeof fakeEvent>,
): void {
  for (const entry of added) {
    if (entry.type === event.type) entry.listener(event as unknown as Event);
  }
}

describe('attachClaim', () => {
  it('listens for every claimed event in the capture phase', () => {
    const { added, frameWindow } = fakeWindow();
    attachClaim(frameWindow, handlers());
    expect(added.map((entry) => entry.type)).toEqual([...CLAIMED_EVENTS]);
    expect(added.every((entry) => entry.capture)).toBe(true);
  });

  it('cancels and stops a click and a submit before any site listener', () => {
    const { added, frameWindow } = fakeWindow();
    attachClaim(frameWindow, handlers());
    for (const type of ['click', 'submit']) {
      const event = fakeEvent(type);
      dispatch(added, event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
      expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    }
  });

  it('routes a click and a double-click with their frame coordinates', () => {
    const { added, frameWindow } = fakeWindow();
    const claim = handlers();
    attachClaim(frameWindow, claim);
    dispatch(added, fakeEvent('click', 12, 34));
    dispatch(added, fakeEvent('dblclick', 56, 78));
    expect(claim.onClick).toHaveBeenCalledExactlyOnceWith(12, 34);
    expect(claim.onDoubleClick).toHaveBeenCalledExactlyOnceWith(56, 78);
  });

  it('claims the other events without routing them', () => {
    const { added, frameWindow } = fakeWindow();
    const claim = handlers();
    attachClaim(frameWindow, claim);
    const event = fakeEvent('contextmenu', 1, 2);
    dispatch(added, event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(claim.onClick).not.toHaveBeenCalled();
    expect(claim.onDoubleClick).not.toHaveBeenCalled();
  });

  it('detaching removes exactly what was added', () => {
    const { added, removed, frameWindow } = fakeWindow();
    const detach = attachClaim(frameWindow, handlers());
    detach();
    expect(removed).toEqual(added);
  });
});
