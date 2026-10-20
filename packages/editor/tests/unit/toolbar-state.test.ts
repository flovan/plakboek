import {
  DEFAULT_TEXT_THEME,
  narrowTextTheme,
} from '@plakboek/content/rich-text';
import { describe, expect, it } from 'vitest';
import { toolbarModel } from '../../src/chrome/editing/text/toolbar-state.js';

const none = () => false;

describe('toolbarModel', () => {
  it('lists Bold for the default theme, pressed when it applies at the selection', () => {
    const idle = toolbarModel({ theme: DEFAULT_TEXT_THEME, isActive: none });
    expect(idle.marks).toEqual([{ id: 'bold', pressed: false }]);
    const bold = toolbarModel({
      theme: DEFAULT_TEXT_THEME,
      isActive: (name) => name === 'bold',
    });
    expect(bold.marks).toEqual([{ id: 'bold', pressed: true }]);
  });

  it('has no Bold button when the theme does not allow the mark', () => {
    const theme = narrowTextTheme(DEFAULT_TEXT_THEME, { marks: ['italic'] });
    expect(toolbarModel({ theme, isActive: none }).marks).toEqual([]);
  });
});
