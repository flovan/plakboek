import {
  DEFAULT_TEXT_THEME,
  narrowTextTheme,
} from '@plakboek/content/rich-text';
import { describe, expect, it } from 'vitest';
import {
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

  it('lists only the list the theme allows', () => {
    const theme = narrowTextTheme(DEFAULT_TEXT_THEME, {
      nodes: ['orderedList'],
    });
    expect(
      toolbarModel({ theme, isActive: none }).lists.map((toggle) => toggle.id),
    ).toEqual(['orderedList']);
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
