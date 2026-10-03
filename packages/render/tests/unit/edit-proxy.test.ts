import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BlockComponent } from '../../src/block-component.js';
import {
  EDIT_PARAM,
  EDITOR_FLAG_KEY,
  TOOLBAR_DISMISSED_KEY,
} from '../../src/constants.js';
import { NOOP_EDIT } from '../../src/edit-proxy.js';

describe('NOOP_EDIT', () => {
  it('has no own enumerable keys and spreads to nothing', () => {
    expect(Object.keys(NOOP_EDIT)).toEqual([]);
    expect(Object.keys({ ...NOOP_EDIT })).toEqual([]);
  });

  it('returns one shared frozen empty object from field() for every key', () => {
    const first = NOOP_EDIT.field('title');
    expect(first).toBe(NOOP_EDIT.field('text'));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.keys({ ...first })).toEqual([]);
  });

  it('is frozen: assigning a property throws in strict mode', () => {
    expect(Object.isFrozen(NOOP_EDIT)).toBe(true);
    const mutate = (): void => {
      (NOOP_EDIT as unknown as Record<string, string>)['data-x'] = 'y';
    };
    expect(mutate).toThrow(TypeError);
  });

  it('adds no data- attribute when a block spreads it on its root and a child', () => {
    const Fixture: BlockComponent = ({ edit, children }): ReactNode =>
      createElement(
        'section',
        { ...edit, className: 'fixture' },
        createElement('h2', { ...edit.field('text') }, 'Heading'),
        children,
      );

    const markup = renderToStaticMarkup(
      createElement(Fixture, {
        block: { id: 'b1', blockType: 'fixture', schemaVersion: 1 },
        props: {},
        children: null,
        edit: NOOP_EDIT,
      }),
    );

    expect(markup).toBe('<section class="fixture"><h2>Heading</h2></section>');
    expect(markup).not.toContain('data-');
  });
});

describe('constants', () => {
  it('names the edit parameter and the namespaced storage keys', () => {
    expect(EDIT_PARAM).toBe('_edit');
    expect(EDITOR_FLAG_KEY).toMatch(/^plakboek:.+/);
    expect(TOOLBAR_DISMISSED_KEY).toMatch(/^plakboek:.+/);
    expect(EDITOR_FLAG_KEY).not.toBe(TOOLBAR_DISMISSED_KEY);
  });
});
