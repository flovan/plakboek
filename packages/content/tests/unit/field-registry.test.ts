import { describe, expect, it } from 'vitest';
import {
  FIELD_TYPES,
  getFieldTypeDefinition,
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

  it('all sixteen field types are registered', () => {
    expect(FIELD_TYPES).toHaveLength(16);
    for (const fieldType of FIELD_TYPES) {
      expect(() => getFieldTypeDefinition(fieldType)).not.toThrow();
    }
  });
});
