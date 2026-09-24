import { describe, expect, it } from 'vitest';
import {
  FieldDefinitionError,
  getFieldTypeDefinition,
  parseFieldOptions,
  type FieldType,
} from '../../../src/field-types/registry.js';

function buildValueSchema(fieldType: FieldType, options: unknown) {
  const definition = getFieldTypeDefinition(fieldType);
  const parsedOptions = parseFieldOptions(fieldType, options);
  return definition.buildValueSchema(parsedOptions);
}

type FailedParseIssue = {
  readonly path: readonly PropertyKey[];
};

type ParseOutcome =
  | { readonly success: true }
  | {
      readonly success: false;
      readonly error: { readonly issues: readonly FailedParseIssue[] };
    };

/** Narrows a `safeParse` result to its failure branch without a
 * conditional `expect(...)` call (oxlint's vitest/no-conditional-expect). */
function failureIssues(result: ParseOutcome): readonly FailedParseIssue[] {
  if (result.success) {
    throw new Error('expected zod safeParse to fail');
  }
  return result.error.issues;
}

describe('image and file', () => {
  it('accept a valid asset id and reject an empty, spaced or oversized one', () => {
    for (const fieldType of ['image', 'file'] as const) {
      const schema = buildValueSchema(fieldType, {});
      expect(schema.safeParse('asset_01H9').success).toBe(true);
      expect(schema.safeParse('').success).toBe(false);
      expect(schema.safeParse('has space').success).toBe(false);
      expect(schema.safeParse('a'.repeat(129)).success).toBe(false);
    }
  });
});

describe('reference', () => {
  it('rejects an empty allowedTypeKeys list, a duplicate key, and maxItems on cardinality single', () => {
    expect(() =>
      parseFieldOptions('reference', {
        allowedTypeKeys: [],
        cardinality: 'single',
      }),
    ).toThrow(FieldDefinitionError);

    expect(() =>
      parseFieldOptions('reference', {
        allowedTypeKeys: ['post', 'post'],
        cardinality: 'single',
      }),
    ).toThrow(FieldDefinitionError);

    expect(() =>
      parseFieldOptions('reference', {
        allowedTypeKeys: ['post'],
        cardinality: 'single',
        maxItems: 2,
      }),
    ).toThrow(FieldDefinitionError);
  });

  it('single accepts a UUID and rejects a non-UUID', () => {
    const schema = buildValueSchema('reference', {
      allowedTypeKeys: ['post'],
      cardinality: 'single',
    });
    expect(
      schema.safeParse('11111111-1111-4111-8111-111111111111').success,
    ).toBe(true);
    expect(schema.safeParse('not-a-uuid').success).toBe(false);
  });

  it('multiple with maxItems accepts distinct UUIDs in order and rejects a repeat or too many', () => {
    const schema = buildValueSchema('reference', {
      allowedTypeKeys: ['post'],
      cardinality: 'multiple',
      maxItems: 2,
    });
    const uuidA = '11111111-1111-4111-8111-111111111111';
    const uuidB = '22222222-2222-4222-8222-222222222222';
    const uuidC = '33333333-3333-4333-8333-333333333333';
    expect(schema.safeParse([uuidA, uuidB]).success).toBe(true);
    expect(schema.safeParse([uuidA, uuidA]).success).toBe(false);
    expect(schema.safeParse([uuidA, uuidB, uuidC]).success).toBe(false);
  });
});

describe('repeater', () => {
  const nameAndBioOptions = {
    fields: [
      { key: 'name', label: 'Name', fieldType: 'short_text', required: true },
      { key: 'bio', label: 'Bio', fieldType: 'rich_text' },
    ],
  };

  it('accepts an item with only the required field, rejects a missing required field with the right path, and rejects an unknown key', () => {
    const schema = buildValueSchema('repeater', nameAndBioOptions);

    expect(schema.safeParse([{ name: 'A' }]).success).toBe(true);

    const missingRequired: ParseOutcome = schema.safeParse([
      { bio: { type: 'doc', content: [{ type: 'text', text: 'x' }] } },
    ]);
    expect(missingRequired.success).toBe(false);
    const issues = failureIssues(missingRequired);
    expect(
      issues.some(
        (issue) =>
          issue.path[0] === 0 && issue.path[issue.path.length - 1] === 'name',
      ),
    ).toBe(true);

    expect(schema.safeParse([{ name: 'A', bogus: 1 }]).success).toBe(false);
  });

  it('rejects a repeater containing a repeater sub-field (D-34)', () => {
    // The inner sub-field carries otherwise-valid repeater options (a
    // non-empty `fields` array) so this test isolates the "repeater cannot
    // contain a repeater" rule -- it would fail regardless of that rule if
    // the inner options were simply incomplete.
    expect(() =>
      parseFieldOptions('repeater', {
        fields: [
          {
            key: 'inner',
            label: 'Inner',
            fieldType: 'repeater',
            options: {
              fields: [{ key: 'x', label: 'X', fieldType: 'short_text' }],
            },
          },
        ],
      }),
    ).toThrow(FieldDefinitionError);
  });
});

describe('multi_select unsatisfiable minItems (D-WR-03)', () => {
  it('refuses a minItems above the number of choices', () => {
    // Values must be distinct and drawn from the choices, so this field
    // would reject every possible input.
    expect(() =>
      parseFieldOptions('multi_select', {
        choices: [
          { value: 'a', labels: { en: 'A' } },
          { value: 'b', labels: { en: 'B' } },
        ],
        minItems: 3,
      }),
    ).toThrow(FieldDefinitionError);
  });

  it('accepts a minItems equal to the number of choices', () => {
    expect(() =>
      parseFieldOptions('multi_select', {
        choices: [
          { value: 'a', labels: { en: 'A' } },
          { value: 'b', labels: { en: 'B' } },
        ],
        minItems: 2,
      }),
    ).not.toThrow();
  });
});
