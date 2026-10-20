/**
 * The keyboard shortcuts of the text toolbar and how they are written. The
 * editor itself binds the formatting keys (they are the extensions' own, see
 * `buildTextExtensions`); this table is what the tooltips and
 * `aria-keyshortcuts` say, so the two cannot drift apart unnoticed. There is
 * no Heading 1 shortcut: the page's title owns h1.
 */
import { STRINGS } from '../../strings.js';

export type ShortcutId =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'bulletList'
  | 'orderedList'
  | 'paragraph'
  | 'title'
  | 'heading'
  | 'subheading'
  | 'toolbar';

export type Shortcut = {
  /** Control, or Command on Apple systems. */
  readonly mod?: true;
  readonly alt?: true;
  readonly shift?: true;
  /** The key as written: a letter in capitals, a digit, or `F10`. */
  readonly key: string;
};

export const TEXT_SHORTCUTS: Readonly<Record<ShortcutId, Shortcut>> = {
  bold: { mod: true, key: 'B' },
  italic: { mod: true, key: 'I' },
  underline: { mod: true, key: 'U' },
  strike: { mod: true, shift: true, key: 'S' },
  bulletList: { mod: true, shift: true, key: '8' },
  orderedList: { mod: true, shift: true, key: '7' },
  paragraph: { mod: true, alt: true, key: '0' },
  title: { mod: true, alt: true, key: '2' },
  heading: { mod: true, alt: true, key: '3' },
  subheading: { mod: true, alt: true, key: '4' },
  toolbar: { alt: true, key: 'F10' },
};

export type Platform = 'mac' | 'other';

export function currentPlatform(): Platform {
  return typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/.test(navigator.platform)
    ? 'mac'
    : 'other';
}

/** The shortcut as a tooltip writes it: `Ctrl+B`, `Cmd+Option+2`. */
export function shortcutLabel(id: ShortcutId, platform: Platform): string {
  const { mod, alt, shift, key } = TEXT_SHORTCUTS[id];
  const mac = platform === 'mac';
  return [
    mod === true ? STRINGS[mac ? 'text.key.cmd' : 'text.key.ctrl'] : null,
    alt === true ? STRINGS[mac ? 'text.key.option' : 'text.key.alt'] : null,
    shift === true ? STRINGS['text.key.shift'] : null,
    key,
  ]
    .filter((part) => part !== null)
    .join('+');
}

/** The shortcut as `aria-keyshortcuts` writes it: `Control+B`, `Meta+Alt+2`. */
export function ariaShortcut(id: ShortcutId, platform: Platform): string {
  const { mod, alt, shift, key } = TEXT_SHORTCUTS[id];
  return [
    mod === true ? (platform === 'mac' ? 'Meta' : 'Control') : null,
    alt === true ? 'Alt' : null,
    shift === true ? 'Shift' : null,
    key,
  ]
    .filter((part) => part !== null)
    .join('+');
}
