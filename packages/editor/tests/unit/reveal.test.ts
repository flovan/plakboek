import { describe, expect, it } from 'vitest';
import { revealScrollTop } from '../../src/client/frame/reveal.js';

describe('revealScrollTop', () => {
  it('gives null for an item fully inside the viewport', () => {
    expect(revealScrollTop({ top: 100, height: 200 }, 800, 500)).toBeNull();
    expect(revealScrollTop({ top: 0, height: 800 }, 800, 500)).toBeNull();
  });

  it('centres an item that fits but is partly or fully outside', () => {
    // fully below: its page position is 1500 + 1000, 200 tall in an 800 viewport
    expect(revealScrollTop({ top: 1000, height: 200 }, 800, 1500)).toBe(2200);
    // partly above the top edge
    expect(revealScrollTop({ top: -50, height: 200 }, 800, 1000)).toBe(650);
  });

  it('puts a taller-than-viewport item 48px below the viewport top', () => {
    expect(revealScrollTop({ top: 400, height: 1200 }, 800, 100)).toBe(452);
  });

  it('never returns a negative top', () => {
    expect(revealScrollTop({ top: -20, height: 100 }, 800, 10)).toBe(0);
    expect(revealScrollTop({ top: 10, height: 2000 }, 800, 0)).toBe(0);
  });
});
