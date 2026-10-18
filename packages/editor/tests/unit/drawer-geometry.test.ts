import { describe, expect, it } from 'vitest';
import {
  DRAWER_WIDTH,
  drawerFits,
  MIN_FRAME_WIDTH,
} from '../../src/client/shell/drawer.js';

describe('drawerFits', () => {
  it('allows the push while the frame keeps its minimum width, and not below', () => {
    expect(drawerFits(DRAWER_WIDTH + MIN_FRAME_WIDTH)).toBe(true);
    expect(drawerFits(DRAWER_WIDTH + MIN_FRAME_WIDTH - 1)).toBe(false);
  });

  it('fits at every width the shell is usable at', () => {
    // 1024px wide window, minus the 56px rail
    expect(drawerFits(1024 - 56)).toBe(true);
  });
});
