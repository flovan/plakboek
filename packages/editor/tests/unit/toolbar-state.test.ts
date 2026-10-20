import {
  DEFAULT_TEXT_THEME,
  narrowTextTheme,
  resolveTextTheme,
} from '@plakboek/content/rich-text';
import { describe, expect, it } from 'vitest';
import {
  choiceLabel,
  toolbarChanges,
  toolbarModel,
} from '../../src/chrome/editing/text/toolbar-state.js';

const none = () => false;

describe('toolbarModel', () => {
  it('lists every control of the default theme in the toolbar order', () => {
    const model = toolbarModel({ theme: DEFAULT_TEXT_THEME, isActive: none });
    expect(model.style).toEqual({
      current: 'paragraph',
      options: ['paragraph', 'title', 'heading', 'subheading'],
    });
    expect(model.marks.map((toggle) => toggle.id)).toEqual([
      'bold',
      'italic',
      'underline',
      'strike',
    ]);
    expect(model.lists.map((toggle) => toggle.id)).toEqual([
      'bulletList',
      'orderedList',
    ]);
    expect(
      [...model.marks, ...model.lists].every((toggle) => !toggle.pressed),
    ).toBe(true);
    // Link sits after the lists, and is its own control rather than a toggle
    expect(model.link).toEqual({ pressed: false });
  });

  it('knows a Button is selected, but only for a theme that has the node', () => {
    const selected = (name: string) => name === 'cta';
    expect(
      toolbarModel({ theme: DEFAULT_TEXT_THEME, isActive: none })
        .buttonSelected,
    ).toBe(false);
    expect(
      toolbarModel({ theme: DEFAULT_TEXT_THEME, isActive: selected })
        .buttonSelected,
    ).toBe(true);
    const noButton = narrowTextTheme(DEFAULT_TEXT_THEME, {
      nodes: ['bulletList'],
    });
    expect(
      toolbarModel({ theme: noButton, isActive: selected }).buttonSelected,
    ).toBe(false);
  });

  it('presses Link while the caret is in a link, and has none without the mark', () => {
    expect(
      toolbarModel({
        theme: DEFAULT_TEXT_THEME,
        isActive: (name) => name === 'link',
      }).link,
    ).toEqual({ pressed: true });
    const noLink = narrowTextTheme(DEFAULT_TEXT_THEME, { marks: ['bold'] });
    expect(toolbarModel({ theme: noLink, isActive: none }).link).toBeNull();
  });

  it('presses the toggles that apply at the selection', () => {
    const model = toolbarModel({
      theme: DEFAULT_TEXT_THEME,
      isActive: (name) => name === 'italic' || name === 'orderedList',
    });
    expect(
      [...model.marks, ...model.lists]
        .filter((toggle) => toggle.pressed)
        .map((toggle) => toggle.id),
    ).toEqual(['italic', 'orderedList']);
  });

  it('names the current style from the heading level at the selection', () => {
    const at = (level: number) =>
      toolbarModel({
        theme: DEFAULT_TEXT_THEME,
        isActive: (name, attributes) =>
          name === 'heading' && attributes?.level === level,
      }).style?.current;
    expect(at(2)).toBe('title');
    expect(at(3)).toBe('heading');
    expect(at(4)).toBe('subheading');
    expect(at(0)).toBe('paragraph');
  });

  it('lists exactly the controls a narrowed theme keeps', () => {
    const theme = narrowTextTheme(DEFAULT_TEXT_THEME, {
      marks: ['bold', 'italic', 'link'],
      nodes: [],
      headingLevels: [],
    });
    const model = toolbarModel({ theme, isActive: none });
    expect(model.marks.map((toggle) => toggle.id)).toEqual(['bold', 'italic']);
    expect(model.lists).toEqual([]);
    expect(model.link).toEqual({ pressed: false });
    // no heading level, so no Text style menu at all
    expect(model.style).toBeNull();
  });

  it('with one heading level allowed offers Paragraph and that level', () => {
    const theme = narrowTextTheme(DEFAULT_TEXT_THEME, { headingLevels: [3] });
    expect(toolbarModel({ theme, isActive: none }).style?.options).toEqual([
      'paragraph',
      'heading',
    ]);
  });

  it('puts Insert after the lists when the theme allows a quote or a divider', () => {
    expect(
      toolbarModel({ theme: DEFAULT_TEXT_THEME, isActive: none }).insert,
    ).toBe(true);
    const onlyQuote = narrowTextTheme(DEFAULT_TEXT_THEME, {
      nodes: ['blockquote'],
    });
    expect(toolbarModel({ theme: onlyQuote, isActive: none }).insert).toBe(
      true,
    );
  });

  it('has no Insert control when nothing is insertable', () => {
    const theme = narrowTextTheme(DEFAULT_TEXT_THEME, {
      nodes: ['bulletList', 'orderedList'],
    });
    expect(toolbarModel({ theme, isActive: none }).insert).toBe(false);
  });

  it('lists only the list the theme allows', () => {
    const theme = narrowTextTheme(DEFAULT_TEXT_THEME, {
      nodes: ['orderedList'],
    });
    expect(
      toolbarModel({ theme, isActive: none }).lists.map((toggle) => toggle.id),
    ).toEqual(['orderedList']);
  });
});

describe('the Custom style control', () => {
  const themed = resolveTextTheme({
    colors: [{ label: 'Accent', token: 'accent' }],
    sizes: [{ label: 'Large', token: 'xl', value: '28px' }],
    align: true,
  });

  it('is absent when the theme declares no colour, size or alignment', () => {
    expect(
      toolbarModel({ theme: DEFAULT_TEXT_THEME, isActive: none }).customStyle,
    ).toBeNull();
  });

  it('carries the palettes, alignment and the custom-value rule the theme declares', () => {
    expect(toolbarModel({ theme: themed, isActive: none }).customStyle).toEqual(
      {
        colors: [{ label: 'Accent', token: 'accent' }],
        sizes: [{ label: 'Large', token: 'xl', value: '28px' }],
        align: true,
        allowCustomValues: true,
      },
    );
  });

  it('is present for alignment alone', () => {
    const theme = resolveTextTheme({ align: true });
    expect(toolbarModel({ theme, isActive: none }).customStyle?.colors).toEqual(
      [],
    );
  });

  it('follows a narrowing that switches the palettes and alignment off', () => {
    const theme = narrowTextTheme(themed, {
      colors: false,
      sizes: false,
      align: false,
    });
    expect(toolbarModel({ theme, isActive: none }).customStyle).toBeNull();
  });

  it('keeps allowCustomValues false when the property narrows it', () => {
    const theme = narrowTextTheme(themed, { allowCustomValues: false });
    expect(
      toolbarModel({ theme, isActive: none }).customStyle?.allowCustomValues,
    ).toBe(false);
  });
});

describe('choiceLabel', () => {
  const entries = [{ label: 'Accent', token: 'accent' }];
  const same = (value: string) => value;

  it('names a palette token by its label', () => {
    expect(choiceLabel(entries, 'accent', same)).toBe('Accent');
  });

  it('writes a literal through the formatter', () => {
    expect(choiceLabel(entries, '#12ab34', same)).toBe('#12ab34');
    expect(choiceLabel(entries, '20px', (value) => `[${value}]`)).toBe(
      '[20px]',
    );
  });

  it('reads a token the palette no longer lists as itself, and nothing as null', () => {
    expect(choiceLabel(entries, 'gone', same)).toBe('gone');
    expect(choiceLabel(entries, null, same)).toBeNull();
  });
});

describe('toolbarChanges', () => {
  const model = (active: readonly string[], level?: number) =>
    toolbarModel({
      theme: DEFAULT_TEXT_THEME,
      isActive: (name, attributes) =>
        name === 'heading'
          ? attributes?.level === level
          : active.includes(name),
    });

  it('reports a toggle that went on or off', () => {
    expect(toolbarChanges(model([]), model(['bold']))).toEqual([
      { kind: 'toggle', id: 'bold', on: true },
    ]);
    expect(toolbarChanges(model(['bold']), model([]))).toEqual([
      { kind: 'toggle', id: 'bold', on: false },
    ]);
  });

  it('reports a style change by the style it ended as', () => {
    expect(toolbarChanges(model([]), model([], 3))).toEqual([
      { kind: 'style', style: 'heading' },
    ]);
    expect(toolbarChanges(model([], 3), model([]))).toEqual([
      { kind: 'style', style: 'paragraph' },
    ]);
  });

  it('reports nothing when nothing changed, and every change otherwise', () => {
    expect(toolbarChanges(model(['italic']), model(['italic']))).toEqual([]);
    expect(
      toolbarChanges(model(['bulletList']), model(['orderedList'])),
    ).toEqual([
      { kind: 'toggle', id: 'bulletList', on: false },
      { kind: 'toggle', id: 'orderedList', on: true },
    ]);
  });
});
