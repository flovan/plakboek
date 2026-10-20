/**
 * What can be inserted into a rich text field: the rows of the '/' menu and of
 * the toolbar's Insert menu. The list is derived from the property's effective
 * theme, so a node the theme does not allow has no item (and is not in the
 * field's schema either). There is no level 1 heading item: the page owns it.
 *
 * An item runs on a command chain, so the '/' menu can delete the typed
 * `/query` and apply the item as one transaction, one undo step.
 */
import type { ChainedCommands } from '@tiptap/core';
import type { TextTheme } from '@plakboek/content/rich-text';
import { STRINGS, type StringKey } from '../../chrome/strings.js';
import { STYLE_LEVEL } from './heading-styles.js';

export type InsertItemId =
  | 'paragraph'
  | 'title'
  | 'heading'
  | 'subheading'
  | 'bulletList'
  | 'orderedList'
  | 'quote'
  | 'divider'
  | 'button';

export type InsertItem = {
  readonly id: InsertItemId;
  readonly label: string;
  /** Applies the item at the selection and returns the chain. */
  readonly run: (chain: ChainedCommands) => ChainedCommands;
};

/** Where the items are offered: the '/' menu lists all, the '+' menu the blocks that are not text styles. */
export type InsertPlace = 'slash' | 'plus';

const LABEL = {
  paragraph: 'text.style.paragraph',
  title: 'text.style.title',
  heading: 'text.style.heading',
  subheading: 'text.style.subheading',
  bulletList: 'text.list.bullet',
  orderedList: 'text.list.ordered',
  quote: 'text.insert.quote',
  divider: 'text.insert.divider',
  button: 'text.insert.button',
} as const satisfies Record<InsertItemId, StringKey>;

const item = (id: InsertItemId, run: InsertItem['run']): InsertItem => ({
  id,
  label: STRINGS[LABEL[id]],
  run,
});

const headingItem = (id: 'title' | 'heading' | 'subheading'): InsertItem =>
  item(id, (chain) => chain.setHeading({ level: STYLE_LEVEL[id] }));

/**
 * The items a theme allows for one place, in the menu's order: Paragraph,
 * Title, Heading, Subheading, Bulleted list, Numbered list, Quote, Divider
 * (and Button once the button node exists). Paragraph alone is not worth a
 * menu: the '/' list is empty when the theme allows nothing else.
 */
export function insertItems(
  theme: TextTheme,
  place: InsertPlace,
): readonly InsertItem[] {
  const nodes = theme.nodes;
  const items: InsertItem[] = [
    ...(place === 'slash'
      ? [
          item('paragraph', (chain) => chain.setParagraph()),
          ...(['title', 'heading', 'subheading'] as const)
            .filter((id) => theme.headingLevels.includes(STYLE_LEVEL[id]))
            .map(headingItem),
          ...(nodes.includes('bulletList')
            ? [item('bulletList', (chain) => chain.toggleBulletList())]
            : []),
          ...(nodes.includes('orderedList')
            ? [item('orderedList', (chain) => chain.toggleOrderedList())]
            : []),
        ]
      : []),
    ...(nodes.includes('blockquote')
      ? [item('quote', (chain) => chain.toggleBlockquote())]
      : []),
    ...(nodes.includes('horizontalRule')
      ? [item('divider', (chain) => chain.setHorizontalRule())]
      : []),
  ];
  return items.length === 1 && items[0]?.id === 'paragraph' ? [] : items;
}

/** The items whose label contains the query, case-insensitive; an empty query keeps all. */
export function filterInsertItems(
  items: readonly InsertItem[],
  query: string,
): readonly InsertItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return items;
  return items.filter((entry) => entry.label.toLowerCase().includes(needle));
}
