import { Extension, Mark, type Extensions } from '@tiptap/core';
import type { TextTheme } from '@plakboek/content/rich-text';

export const TextColor = Mark.create({ name: 'textColor' });
export const TextSize = Mark.create({ name: 'textSize' });
export const TextAlignAttribute = Extension.create({ name: 'textAlign' });

export function unlockExtensions(_theme: TextTheme): Extensions {
  return [];
}
