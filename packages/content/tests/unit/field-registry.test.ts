import { describe, expect, it } from 'vitest';
import {
  FIELD_TYPE_DEFINITIONS,
  FIELD_TYPES,
  getFieldTypeDefinition,
  type FieldTypeDefinition,
  type FieldTypeDefinitions,
} from '../../src/field-types/registry.js';

describe('field type registry completeness (FIELD-02, FIELD-04)', () => {
  it('every registered field type has a defaultWidget among its own widgets', () => {
    for (const fieldType of FIELD_TYPES) {
      const definition = getFieldTypeDefinition(fieldType);
      expect(definition.widgets).toContain(definition.defaultWidget);
    }
  });

  it('allowedInRepeater is false only for repeater', () => {
    for (const fieldType of FIELD_TYPES) {
      const definition = getFieldTypeDefinition(fieldType);
      expect(definition.allowedInRepeater).toBe(fieldType !== 'repeater');
    }
  });

  it('all sixteen field types are registered, each under its own key', () => {
    expect(FIELD_TYPES).toHaveLength(16);
    for (const fieldType of FIELD_TYPES) {
      expect(() => getFieldTypeDefinition(fieldType)).not.toThrow();
      expect(getFieldTypeDefinition(fieldType).fieldType).toBe(fieldType);
    }
  });
});

const { short_text: omittedShortText, ...restOfDefinitions } =
  FIELD_TYPE_DEFINITIONS;
const missingKeyRecord = {
  ...restOfDefinitions,
  // @ts-expect-error -- short_text is missing from this record
} satisfies FieldTypeDefinitions;

const unknownKeyRecord = {
  ...FIELD_TYPE_DEFINITIONS,
  // @ts-expect-error -- "currency" is not a member of FieldType
  currency: FIELD_TYPE_DEFINITIONS.short_text,
} satisfies FieldTypeDefinitions;

const wrongKeyRecord = {
  ...FIELD_TYPE_DEFINITIONS,
  // @ts-expect-error -- number's definition filed under short_text's key
  short_text: FIELD_TYPE_DEFINITIONS.number,
  // @ts-expect-error -- short_text's definition filed under number's key
  number: FIELD_TYPE_DEFINITIONS.short_text,
} satisfies FieldTypeDefinitions;

const typoDefinition = {
  ...FIELD_TYPE_DEFINITIONS.short_text,
  // @ts-expect-error -- "shrot_text" is a typo of "short_text"
  fieldType: 'shrot_text',
} satisfies FieldTypeDefinition<unknown>;

describe('FieldTypeDefinitions (FIELD-02, FIELD-04): compile-time drift pins', () => {
  it('keeps the four @ts-expect-error pins above live, each guarding a real value', () => {
    expect(missingKeyRecord.long_text).toBe(FIELD_TYPE_DEFINITIONS.long_text);
    expect(omittedShortText.fieldType).toBe('short_text');
    expect(unknownKeyRecord.currency).toBe(FIELD_TYPE_DEFINITIONS.short_text);
    expect(wrongKeyRecord.short_text).toBe(FIELD_TYPE_DEFINITIONS.number);
    expect(wrongKeyRecord.number).toBe(FIELD_TYPE_DEFINITIONS.short_text);
    expect(typoDefinition.fieldType).toBe('shrot_text');
  });
});
