import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ariaShortcut,
  shortcutLabel,
  TEXT_SHORTCUTS,
} from '../../src/chrome/editing/text/shortcuts.js';

describe('shortcutLabel', () => {
  it('writes Ctrl on other systems and Cmd on Apple systems', () => {
    expect(shortcutLabel('bold', 'other')).toBe('Ctrl+B');
    expect(shortcutLabel('bold', 'mac')).toBe('Cmd+B');
    expect(shortcutLabel('strike', 'other')).toBe('Ctrl+Shift+S');
    expect(shortcutLabel('orderedList', 'mac')).toBe('Cmd+Shift+7');
  });

  it('writes the heading styles with Alt, or Option on Apple systems', () => {
    expect(shortcutLabel('title', 'other')).toBe('Ctrl+Alt+2');
    expect(shortcutLabel('subheading', 'mac')).toBe('Cmd+Option+4');
    expect(shortcutLabel('paragraph', 'other')).toBe('Ctrl+Alt+0');
  });

  it('writes the toolbar key without a modifier', () => {
    expect(shortcutLabel('toolbar', 'other')).toBe('Alt+F10');
    expect(shortcutLabel('toolbar', 'mac')).toBe('Option+F10');
  });
});

describe('ariaShortcut', () => {
  it('says Control, or Meta on Apple systems', () => {
    expect(ariaShortcut('italic', 'other')).toBe('Control+I');
    expect(ariaShortcut('italic', 'mac')).toBe('Meta+I');
    expect(ariaShortcut('heading', 'other')).toBe('Control+Alt+3');
    expect(ariaShortcut('toolbar', 'mac')).toBe('Alt+F10');
  });
});

describe('the table', () => {
  it('has no Heading 1 shortcut: the page owns h1', () => {
    expect(
      Object.values(TEXT_SHORTCUTS).some((entry) => entry.key === '1'),
    ).toBe(false);
    const source = readFileSync(
      fileURLToPath(
        new URL('../../src/chrome/editing/text/shortcuts.ts', import.meta.url),
      ),
      'utf8',
    );
    expect(source).not.toMatch(/Mod-Alt-1|Mod\+Alt\+1/);
  });
});
