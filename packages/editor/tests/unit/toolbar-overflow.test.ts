import { describe, expect, it } from 'vitest';
import {
  collapseToolbar,
  type CollapseInput,
  type ControlId,
} from '../../src/chrome/editing/text/toolbar-overflow.js';

/** Every control present: Text style 112, toggles 32, Done 80 of which 48 is its text. */
const WIDTHS: Partial<Record<ControlId, number>> = {
  style: 112,
  bold: 32,
  italic: 32,
  underline: 32,
  strike: 32,
  bulletList: 32,
  orderedList: 32,
  insert: 32,
  done: 80,
};

const at = (
  available: number,
  widths: CollapseInput['widths'] = WIDTHS,
): ReturnType<typeof collapseToolbar> =>
  collapseToolbar({ widths, available, doneTextWidth: 48 });

// The bar's width for the stages below: 478 whole, 430 with Done icon-only
// (which Strikethrough moving into More leaves unchanged: More is as wide as
// the control it replaces), 394 without Underline, 358 without Numbered list,
// 317 without Bulleted list.
describe('collapseToolbar', () => {
  it('keeps everything, with Done and its text, when there is room', () => {
    expect(at(478)).toEqual({
      visible: [
        'style',
        'bold',
        'italic',
        'underline',
        'strike',
        'bulletList',
        'orderedList',
        'insert',
      ],
      inMore: [],
      doneIconOnly: false,
    });
    expect(at(2000).doneIconOnly).toBe(false);
  });

  it('turns Done icon-only and moves nothing when 40px too little', () => {
    const collapsed = at(478 - 40);
    expect(collapsed.doneIconOnly).toBe(true);
    expect(collapsed.inMore).toEqual([]);
    expect(at(430).inMore).toEqual([]);
  });

  it('moves Strikethrough, then Underline, then Numbered list, then Bulleted list', () => {
    expect(at(429).inMore).toEqual(['underline', 'strike']);
    expect(at(394).inMore).toEqual(['underline', 'strike']);
    expect(at(393).inMore).toEqual(['underline', 'strike', 'orderedList']);
    expect(at(358).inMore).toEqual(['underline', 'strike', 'orderedList']);
    expect(at(357).inMore).toEqual([
      'underline',
      'strike',
      'bulletList',
      'orderedList',
    ]);
    expect(at(317).inMore).toHaveLength(4);
    expect(at(317).visible).toEqual(['style', 'bold', 'italic', 'insert']);
  });

  it('never moves Text style, whatever the room', () => {
    for (const available of [0, 50, 200, 317, 400, 478]) {
      const collapsed = at(available);
      expect(collapsed.visible).toContain('style');
      expect(collapsed.inMore).not.toContain('style');
    }
    expect(at(0).inMore).toHaveLength(4);
    expect(at(0).doneIconOnly).toBe(true);
  });

  it('leaves out of More the controls a narrowed theme never had', () => {
    const narrowed = { ...WIDTHS };
    delete narrowed.strike;
    delete narrowed.bulletList;
    delete narrowed.orderedList;
    delete narrowed.underline;
    expect(at(0, narrowed).inMore).toEqual([]);
    expect(at(0, narrowed).visible).toEqual([
      'style',
      'bold',
      'italic',
      'insert',
    ]);
  });

  it('counts the Custom style label in the bar and never moves it', () => {
    const withCustom = { ...WIDTHS, customStyle: 118 };
    // 478 whole + 4px gap + 118
    expect(at(600, withCustom).doneIconOnly).toBe(false);
    expect(at(599, withCustom).doneIconOnly).toBe(true);
    const squeezed = at(0, withCustom);
    expect(squeezed.visible).not.toContain('customStyle');
    expect(squeezed.inMore).not.toContain('customStyle');
    expect(squeezed.doneIconOnly).toBe(true);
  });
});
