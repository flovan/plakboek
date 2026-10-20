import {
  DEFAULT_TEXT_THEME,
  narrowTextTheme,
} from '@plakboek/content/rich-text';
import { describe, expect, it } from 'vitest';
import {
  filterInsertItems,
  insertItems,
} from '../../src/client/text/insert-items.js';

const ids = (items: readonly { readonly id: string }[]) =>
  items.map((item) => item.id);

describe('insertItems', () => {
  it("lists the default theme's '/' items in the menu's order", () => {
    expect(ids(insertItems(DEFAULT_TEXT_THEME, 'slash'))).toEqual([
      'paragraph',
      'title',
      'heading',
      'subheading',
      'bulletList',
      'orderedList',
      'quote',
      'divider',
    ]);
  });

  it("lists only the blocks that are not text styles in the '+' menu", () => {
    expect(ids(insertItems(DEFAULT_TEXT_THEME, 'plus'))).toEqual([
      'quote',
      'divider',
    ]);
  });

  it('has no level 1 item in either place', () => {
    for (const place of ['slash', 'plus'] as const) {
      const labels = insertItems(DEFAULT_TEXT_THEME, place).map(
        (item) => item.label,
      );
      expect(labels.some((label) => /title 1|heading 1|h1/i.test(label))).toBe(
        false,
      );
    }
    expect(
      ids(insertItems(DEFAULT_TEXT_THEME, 'slash')).filter((id) =>
        ['title', 'heading', 'subheading'].includes(id),
      ),
    ).toHaveLength(3);
  });

  it('lists only what a narrowed theme allows', () => {
    const theme = narrowTextTheme(DEFAULT_TEXT_THEME, {
      headingLevels: [3],
      nodes: ['bulletList', 'blockquote'],
    });
    expect(ids(insertItems(theme, 'slash'))).toEqual([
      'paragraph',
      'heading',
      'bulletList',
      'quote',
    ]);
    expect(ids(insertItems(theme, 'plus'))).toEqual(['quote']);
  });

  it('lists nothing when only paragraphs are allowed', () => {
    const theme = narrowTextTheme(DEFAULT_TEXT_THEME, {
      headingLevels: [],
      nodes: [],
    });
    expect(insertItems(theme, 'slash')).toEqual([]);
    expect(insertItems(theme, 'plus')).toEqual([]);
  });

  it('never lists Button before the button node exists', () => {
    expect(ids(insertItems(DEFAULT_TEXT_THEME, 'slash'))).not.toContain(
      'button',
    );
    expect(ids(insertItems(DEFAULT_TEXT_THEME, 'plus'))).not.toContain(
      'button',
    );
  });
});

describe('filterInsertItems', () => {
  const items = insertItems(DEFAULT_TEXT_THEME, 'slash');

  it('keeps every item for an empty filter', () => {
    expect(filterInsertItems(items, '')).toEqual(items);
  });

  it('matches the label case-insensitively', () => {
    expect(ids(filterInsertItems(items, 'SUB'))).toEqual(['subheading']);
    expect(ids(filterInsertItems(items, 'list'))).toEqual([
      'bulletList',
      'orderedList',
    ]);
  });

  it('keeps the menu order and drops what does not match', () => {
    expect(ids(filterInsertItems(items, 'e'))).toEqual([
      'title',
      'heading',
      'subheading',
      'bulletList',
      'orderedList',
      'quote',
      'divider',
    ]);
    expect(filterInsertItems(items, 'zzz')).toEqual([]);
  });
});
