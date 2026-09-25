/**
 * Per-property installation constraints (BLOCK-08, D-04): `constrainBlock`/
 * `applyBlockConstraints` hide, fix or narrow a built-in block's declared
 * property without editing core, and `resolveBlockProperties`/
 * `validateBlockProps` (registry.ts) tell the three states apart by a
 * `constraint` discriminant rather than by absence alone.
 */
import { describe, expect, it } from 'vitest';
import {
  applyBlockConstraints,
  BlockConstraintError,
  constrainBlock,
} from '../../src/constraints.js';
import {
  defineBlocks,
  resolveBlockProperties,
  validateBlockProps,
} from '../../src/registry.js';

const cardChoices = {
  choices: [
    { value: 'primary', labels: { en: 'Primary' } },
    { value: 'ghost', labels: { en: 'Ghost' } },
    { value: 'secondary', labels: { en: 'Secondary' } },
  ],
};

function defineCard() {
  return defineBlocks([
    {
      key: 'card',
      editor: { label: 'Card' },
      schemaVersion: 1,
      properties: {
        image: { fieldType: 'image', label: 'Image', options: {} },
        padding: {
          fieldType: 'select',
          label: 'Padding',
          options: {
            choices: [
              { value: 'sm', labels: { en: 'Small' } },
              { value: 'lg', labels: { en: 'Large' } },
            ],
          },
        },
        variant: {
          fieldType: 'select',
          label: 'Variant',
          options: cardChoices,
        },
        title: { fieldType: 'short_text', label: 'Title', options: {} },
      },
    },
  ]);
}

describe('applyBlockConstraints/constrainBlock (BLOCK-08, D-04)', () => {
  it('hides a property: resolveBlockProperties omits it, but the declaration still knows it exists', () => {
    const [card] = defineCard();
    const [constrained] = applyBlockConstraints(
      [card!],
      [constrainBlock('card', { image: 'hidden' })],
    );
    const resolved = resolveBlockProperties(constrained!);
    expect(resolved.image).toBeUndefined();
    expect(constrained!.properties.image).toBeDefined();
  });

  it('fixes a property: resolves present, non-editable, with the fixed value; validateBlockProps accepts only that value', () => {
    const [card] = defineCard();
    const [constrained] = applyBlockConstraints(
      [card!],
      [constrainBlock('card', { padding: { fixed: 'lg' } })],
    );
    const resolved = resolveBlockProperties(constrained!);
    expect(resolved.padding?.constraint).toBe('fixed');
    expect(resolved.padding?.fixedValue).toBe('lg');

    const withFixedValue = validateBlockProps(constrained!, {
      padding: 'lg',
      title: 'Hello',
    });
    expect(withFixedValue.padding).toBe('lg');

    // Omitting it entirely still resolves to the fixed value.
    const withoutSubmission = validateBlockProps(constrained!, {
      title: 'Hello',
    });
    expect(withoutSubmission.padding).toBe('lg');

    expect(() =>
      validateBlockProps(constrained!, { padding: 'sm', title: 'Hello' }),
    ).toThrow('invalid block props');
  });

  it('narrows a select property: choices restricted, an out-of-range submission fails validation', () => {
    const [card] = defineCard();
    const [constrained] = applyBlockConstraints(
      [card!],
      [constrainBlock('card', { variant: { allow: ['primary', 'ghost'] } })],
    );
    const resolved = resolveBlockProperties(constrained!);
    expect(resolved.variant?.constraint).toBe('narrowed');
    expect(resolved.variant?.allowedValues).toEqual(['primary', 'ghost']);

    const valid = validateBlockProps(constrained!, {
      variant: 'primary',
      title: 'Hello',
    });
    expect(valid.variant).toBe('primary');

    expect(() =>
      validateBlockProps(constrained!, {
        variant: 'secondary',
        title: 'Hello',
      }),
    ).toThrow('invalid block props');
  });

  it('distinguishes hidden, fixed, narrowed and none by a constraint discriminant, not by absence', () => {
    const [card] = defineCard();
    const [constrained] = applyBlockConstraints(
      [card!],
      [
        constrainBlock('card', {
          image: 'hidden',
          padding: { fixed: 'lg' },
          variant: { allow: ['primary'] },
        }),
      ],
    );
    const resolved = resolveBlockProperties(constrained!);
    expect(resolved.padding?.constraint).toBe('fixed');
    expect(resolved.variant?.constraint).toBe('narrowed');
    expect(resolved.title?.constraint).toBe('none');
    expect(Object.keys(resolved)).not.toContain('image');
  });

  it('collects every problem across every set -- unknown property, invalid fixed value, out-of-range allow, allow on an unsupported field type', () => {
    const [card] = defineCard();
    let caught: unknown;
    try {
      applyBlockConstraints(
        [card!],
        [
          constrainBlock('card', {
            doesNotExist: 'hidden',
            padding: { fixed: 'not-a-choice' },
            variant: { allow: ['not-a-choice'] },
            title: { allow: ['whatever'] },
          }),
        ],
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BlockConstraintError);
    const codes = (caught as BlockConstraintError).issues
      .map((issue) => issue.code)
      .sort();
    expect(codes).toEqual(
      [
        'UNKNOWN_PROPERTY',
        'INVALID_FIXED_VALUE',
        'INVALID_ALLOW_VALUE',
        'ALLOW_NOT_SUPPORTED',
      ].sort(),
    );
  });

  it('refuses a constraint set naming a block the composed array does not declare', () => {
    const [card] = defineCard();
    expect(() =>
      applyBlockConstraints(
        [card!],
        [constrainBlock('does-not-exist', { title: 'hidden' })],
      ),
    ).toThrow(BlockConstraintError);
  });

  it('refuses two sets constraining the same block property twice (not an override mechanism)', () => {
    const [card] = defineCard();
    let caught: unknown;
    try {
      applyBlockConstraints(
        [card!],
        [
          constrainBlock('card', { title: 'hidden' }),
          constrainBlock('card', { title: { fixed: 'x' } }),
        ],
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BlockConstraintError);
    expect(
      (caught as BlockConstraintError).issues.some(
        (issue) => issue.code === 'DUPLICATE_CONSTRAINT',
      ),
    ).toBe(true);
  });

  it('never touches a stored value: a hidden or fixed constraint does not change what a stored row already holds', () => {
    // The declaration's own `properties` map (what a stored row is read
    // against) is untouched by a constraint -- only the resolved,
    // editor/write-facing map changes. This is the load-bearing guarantee
    // constraints.ts's header comment states: applyBlockConstraints reads
    // no row and writes nothing.
    const [card] = defineCard();
    const storedProps = Object.freeze({ image: 'https://example.com/a.png' });

    const [constrained] = applyBlockConstraints(
      [card!],
      [constrainBlock('card', { image: 'hidden' })],
    );

    // The property is still declared on the definition (not deleted), so a
    // direct read of a stored row's `image` value is unaffected by the
    // constraint -- only `resolveBlockProperties`'s editor/write-facing map
    // omits it.
    expect(constrained!.properties.image).toBeDefined();
    expect(storedProps.image).toBe('https://example.com/a.png');

    const [unconstrained] = defineCard();
    expect(unconstrained!.properties.image).toEqual(card!.properties.image);
  });

  it('lets a hidden property key submitted by a caller be rejected as unknown, never silently accepted', () => {
    const [card] = defineCard();
    const [constrained] = applyBlockConstraints(
      [card!],
      [constrainBlock('card', { image: 'hidden' })],
    );
    expect(() =>
      validateBlockProps(constrained!, {
        image: 'https://example.com/b.png',
        title: 'Hello',
      }),
    ).toThrow('invalid block props');
  });
});
