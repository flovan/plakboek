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

describe('number', () => {
  it('accepts values within inclusive bounds and rejects values outside them', () => {
    const schema = buildValueSchema('number', { min: 0, max: 10 });
    expect(schema.safeParse(0).success).toBe(true);
    expect(schema.safeParse(10).success).toBe(true);
    expect(schema.safeParse(2.5).success).toBe(true);
    expect(schema.safeParse(-0.0001).success).toBe(false);
    expect(schema.safeParse(10.0001).success).toBe(false);
  });

  it('rejects NaN and Infinity', () => {
    const schema = buildValueSchema('number', {});
    expect(schema.safeParse(Number.NaN).success).toBe(false);
    expect(schema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });
});

describe('integer', () => {
  it('accepts a safe integer within bounds and rejects out-of-range values', () => {
    const schema = buildValueSchema('integer', { min: 1 });
    expect(schema.safeParse(1).success).toBe(true);
    expect(schema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
    expect(schema.safeParse(0).success).toBe(false);
    expect(schema.safeParse(1.5).success).toBe(false);
    expect(schema.safeParse(2 ** 53).success).toBe(false);
  });
});

describe('boolean', () => {
  it('accepts false, and a required boolean holding false is not empty', () => {
    const definition = getFieldTypeDefinition('boolean');
    const schema = buildValueSchema('boolean', {});
    expect(schema.safeParse(false).success).toBe(true);
    expect(definition.isEmptyValue(false)).toBe(false);
  });
});

describe('date_time', () => {
  it('normalises an offset instant to a UTC Z string', () => {
    const schema = buildValueSchema('date_time', {});
    const result = schema.safeParse('2026-09-16T10:00:00+02:00');
    expect(result.success).toBe(true);
    expect(result.success && result.data).toBe('2026-09-16T08:00:00.000Z');
  });

  it('rejects an instant with no offset and an impossible calendar date', () => {
    const schema = buildValueSchema('date_time', {});
    expect(schema.safeParse('2026-09-16T10:00:00').success).toBe(false);
    expect(schema.safeParse('2026-02-30T10:00:00Z').success).toBe(false);
  });

  it('compares min/max instants inclusively', () => {
    const schema = buildValueSchema('date_time', {
      min: '2026-01-01T00:00:00Z',
      max: '2026-01-01T00:00:00Z',
    });
    expect(schema.safeParse('2026-01-01T00:00:00Z').success).toBe(true);
    expect(schema.safeParse('2026-01-01T00:00:01Z').success).toBe(false);
  });

  it('in date mode accepts YYYY-MM-DD unchanged and rejects other shapes', () => {
    const schema = buildValueSchema('date_time', { mode: 'date' });
    const result = schema.safeParse('2026-09-16');
    expect(result.success).toBe(true);
    expect(result.success && result.data).toBe('2026-09-16');
    expect(schema.safeParse('2026-9-16').success).toBe(false);
    expect(schema.safeParse('2026-09-16T10:00:00Z').success).toBe(false);
  });
});

describe('select', () => {
  it('rejects duplicate choice values, an invalid choice value, and an empty choice list', () => {
    expect(() =>
      parseFieldOptions('select', {
        choices: [
          { value: 'news', labels: { en: 'News' } },
          { value: 'news', labels: { en: 'News again' } },
        ],
      }),
    ).toThrow(FieldDefinitionError);

    expect(() =>
      parseFieldOptions('select', {
        choices: [{ value: 'Has Space', labels: { en: 'Bad' } }],
      }),
    ).toThrow(FieldDefinitionError);

    expect(() => parseFieldOptions('select', { choices: [] })).toThrow(
      FieldDefinitionError,
    );
  });

  it('rejects a label keyed by an uppercase locale and accepts a lowercase one', () => {
    expect(() =>
      parseFieldOptions('select', {
        choices: [{ value: 'news', labels: { EN: 'News' } }],
      }),
    ).toThrow(FieldDefinitionError);

    expect(() =>
      parseFieldOptions('select', {
        choices: [{ value: 'news', labels: { en: 'News' } }],
      }),
    ).not.toThrow();
  });

  it('accepts a configured choice value and rejects an unconfigured one', () => {
    const schema = buildValueSchema('select', {
      choices: [
        { value: 'news', labels: { en: 'News' } },
        { value: 'blog', labels: { en: 'Blog' } },
      ],
    });
    expect(schema.safeParse('news').success).toBe(true);
    expect(schema.safeParse('events').success).toBe(false);
  });
});

describe('multi_select', () => {
  it('enforces inclusive item bounds, rejects duplicates, and treats [] as empty', () => {
    const definition = getFieldTypeDefinition('multi_select');
    const schema = buildValueSchema('multi_select', {
      choices: [
        { value: 'news', labels: { en: 'News' } },
        { value: 'blog', labels: { en: 'Blog' } },
        { value: 'events', labels: { en: 'Events' } },
      ],
      minItems: 1,
      maxItems: 2,
    });
    expect(schema.safeParse(['news']).success).toBe(true);
    expect(schema.safeParse(['news', 'blog']).success).toBe(true);
    expect(schema.safeParse([]).success).toBe(false);
    expect(schema.safeParse(['news', 'news']).success).toBe(false);
    expect(schema.safeParse(['news', 'blog', 'events']).success).toBe(false);
    expect(definition.isEmptyValue([])).toBe(true);
  });
});
