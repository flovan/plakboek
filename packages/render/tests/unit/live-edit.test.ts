import { describe, expect, it } from 'vitest';
import type { EditProxy } from '../../src/edit-proxy.js';
import { createLiveEdit, EDIT_ATTRIBUTE } from '../../src/live-edit.js';

function proxy(overrides: Partial<Parameters<typeof createLiveEdit>[0]> = {}) {
  return createLiveEdit({
    id: 'block-1',
    blockType: 'hero',
    kind: 'section',
    label: 'Hero',
    ...overrides,
  });
}

describe('EDIT_ATTRIBUTE', () => {
  it('names the edit-mode contract', () => {
    expect(EDIT_ATTRIBUTE).toEqual({
      block: 'data-pk-block',
      type: 'data-pk-type',
      kind: 'data-pk-kind',
      label: 'data-pk-label',
      field: 'data-pk-field',
      unavailable: 'data-pk-unavailable',
      empty: 'data-pk-empty',
      inlineEditing: 'data-pk-inline-editing',
    });
    expect(Object.isFrozen(EDIT_ATTRIBUTE)).toBe(true);
  });
});

describe('createLiveEdit', () => {
  it('spreads exactly the four root attributes', () => {
    expect({ ...proxy() }).toEqual({
      'data-pk-block': 'block-1',
      'data-pk-type': 'hero',
      'data-pk-kind': 'section',
      'data-pk-label': 'Hero',
    });
  });

  it('carries the kind it is given', () => {
    expect({ ...proxy({ kind: 'block' }) }['data-pk-kind']).toBe('block');
  });

  it('keeps field off the enumerable keys so it never spreads', () => {
    const edit = proxy();
    expect(Object.keys(edit)).toEqual([
      'data-pk-block',
      'data-pk-type',
      'data-pk-kind',
      'data-pk-label',
    ]);
    expect(Object.keys({ ...edit })).not.toContain('field');
    expect(typeof edit.field).toBe('function');
  });

  it('field(name) yields the one field attribute and is frozen', () => {
    const attributes = proxy().field('title');
    expect(attributes).toEqual({ 'data-pk-field': 'title' });
    expect(Object.isFrozen(attributes)).toBe(true);
  });

  it('is frozen and cannot be reconfigured', () => {
    const edit: EditProxy = proxy();
    expect(Object.isFrozen(edit)).toBe(true);
    expect(() => {
      Object.defineProperty(edit, 'field', { value: () => ({}) });
    }).toThrow(/field/);
  });

  it('keeps hostile values as plain strings', () => {
    const edit = proxy({ label: '"><script>alert(1)</script>' });
    expect({ ...edit }['data-pk-label']).toBe('"><script>alert(1)</script>');
  });
});
