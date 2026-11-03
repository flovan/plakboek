import { describe, expect, it } from 'vitest';
import {
  documentBox,
  visibleDocumentBox,
} from '../../src/client/chrome-host/coordinates.js';

describe('documentBox', () => {
  it('moves a viewport rectangle by the scroll offset', () => {
    expect(
      documentBox(
        { left: 10, top: 20, width: 30, height: 40 },
        { scrollX: 5, scrollY: 300 },
      ),
    ).toEqual({ left: 15, top: 320, width: 30, height: 40 });
  });
});

describe('visibleDocumentBox', () => {
  it('is the part of the document the frame shows', () => {
    expect(
      visibleDocumentBox({
        scrollX: 0,
        scrollY: 300,
        innerWidth: 696,
        innerHeight: 800,
      }),
    ).toEqual({ left: 0, top: 300, width: 696, height: 800 });
  });
});
