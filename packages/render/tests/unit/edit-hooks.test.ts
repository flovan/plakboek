import { describe, expect, it } from 'vitest';
import { defineBlockEdit } from '../../src/edit-hooks.js';

describe('defineBlockEdit', () => {
  it('returns the module it was given, untouched', () => {
    const module = {
      blockType: 'accordion',
      hooks: { select: () => undefined },
    };
    expect(defineBlockEdit(module)).toBe(module);
  });

  it('types the hook set and props', () => {
    defineBlockEdit<{ readonly open: number }>({
      blockType: 'accordion',
      hooks: {
        reveal: ({ props, targetId }) => {
          expect(typeof props.open + targetId).toBeDefined();
        },
      },
    });
    defineBlockEdit({
      blockType: 'accordion',
      hooks: {
        // @ts-expect-error a hook name outside the set is refused
        hover: () => undefined,
      },
    });
  });
});
