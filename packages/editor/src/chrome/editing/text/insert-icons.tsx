import type { ReactElement } from 'react';
import type { InsertItemId } from '../../../client/text/insert-items.js';
import {
  CtaIcon,
  DividerIcon,
  ListBulletIcon,
  ListNumberedIcon,
  QuoteIcon,
} from '../../icons.js';
import type { ShortcutId } from './shortcuts.js';

/**
 * The icon of an insert item. The four text styles have none: their rows keep
 * the icon's 16px slot empty, so every label starts at the same place.
 */
export function InsertIcon(props: { readonly id: InsertItemId }): ReactElement {
  switch (props.id) {
    case 'bulletList':
      return <ListBulletIcon />;
    case 'orderedList':
      return <ListNumberedIcon />;
    case 'quote':
      return <QuoteIcon />;
    case 'divider':
      return <DividerIcon />;
    case 'button':
      return <CtaIcon />;
    default:
      return <span className="inline-block h-4 w-4" aria-hidden="true" />;
  }
}

/** The shortcut an item has, shown as a hint in the '/' menu. */
export const INSERT_SHORTCUT: Readonly<
  Partial<Record<InsertItemId, ShortcutId>>
> = {
  paragraph: 'paragraph',
  title: 'title',
  heading: 'heading',
  subheading: 'subheading',
  bulletList: 'bulletList',
  orderedList: 'orderedList',
};
