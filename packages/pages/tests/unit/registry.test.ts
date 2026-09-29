import { registerHostFieldType, registerHostWidget } from '@plakboek/content';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  BLOCK_KEY_PATTERN,
  BlockConfigError,
  defineBlocks,
  getBlockDefinition,
  UnknownBlockTypeError,
  validateBlockProps,
  type BlockDefinitionInput,
} from '../../src/registry.js';

const starRatingFieldType = {
  fieldType: 'star_rating_r1',
  optionsSchema: z.strictObject({ max: z.int().min(1).default(5) }),
  buildValueSchema: (options: { max: number }) =>
    z.int().min(0).max(options.max),
  isEmptyValue: (value: unknown) => value === undefined || value === null,
  widgets: ['stars', 'numeric'] as const,
  defaultWidget: 'stars',
  allowedInRepeater: false,
};

describe('defineBlocks: the full block declaration contract (D-01, D-02, D-10)', () => {
  it('collects every problem across every entry -- never fails on the first bad entry or field', () => {
    const bad: BlockDefinitionInput = {
      key: 'Bad Key!',
      editor: { label: 'Bad' },
      schemaVersion: 4,
      minSupportedVersion: 5,
      upcasters: {
        2: (props) => props,
        4: (props) => props,
      },
      properties: {
        broken: { fieldType: 'not_a_real_field_type', label: 'Broken' },
      },
    };

    let caught: unknown;
    try {
      defineBlocks([bad]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BlockConfigError);
    const issues = (caught as BlockConfigError).issues;
    expect(issues.map((issue) => issue.code).sort()).toEqual(
      [
        'INVALID_KEY',
        'INVALID_MIN_SUPPORTED_VERSION',
        'UNKNOWN_FIELD_TYPE',
        'UPCASTER_GAP',
      ].sort(),
    );
    expect(issues).toHaveLength(4);
  });

  it('accepts a declaration whose key matches BLOCK_KEY_PATTERN', () => {
    expect(BLOCK_KEY_PATTERN.test('hero')).toBe(true);
    expect(BLOCK_KEY_PATTERN.test('Bad Key!')).toBe(false);
  });

  it('throws once per invalid schemaVersion', () => {
    expect(() =>
      defineBlocks([
        {
          key: 'zero',
          editor: { label: 'Zero' },
          schemaVersion: 0,
          properties: {},
        },
      ]),
    ).toThrow(BlockConfigError);
  });

  it('accepts a fully contiguous upcasters map and refuses a gap', () => {
    expect(() =>
      defineBlocks([
        {
          key: 'complete',
          editor: { label: 'Complete' },
          schemaVersion: 3,
          upcasters: { 2: (props) => props, 3: (props) => props },
          properties: {},
        },
      ]),
    ).not.toThrow();

    let caught: unknown;
    try {
      defineBlocks([
        {
          key: 'gapped',
          editor: { label: 'Gapped' },
          schemaVersion: 3,
          upcasters: { 3: (props) => props },
          properties: {},
        },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BlockConfigError);
    expect(
      (caught as BlockConfigError).issues.some(
        (issue) => issue.code === 'UPCASTER_GAP',
      ),
    ).toBe(true);
  });

  it('refuses an upcasters key below 2 or above schemaVersion', () => {
    let caught: unknown;
    try {
      defineBlocks([
        {
          key: 'outOfRange',
          editor: { label: 'Out of range' },
          schemaVersion: 2,
          upcasters: {
            1: (props) => props,
            2: (props) => props,
            5: (props) => props,
          },
          properties: {},
        },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BlockConfigError);
    const codes = (caught as BlockConfigError).issues.map(
      (issue) => issue.code,
    );
    expect(
      codes.filter((code) => code === 'UPCASTER_OUT_OF_RANGE'),
    ).toHaveLength(2);
  });

  it('refuses a minSupportedVersion above schemaVersion or below 1', () => {
    expect(() =>
      defineBlocks([
        {
          key: 'floorTooHigh',
          editor: { label: 'Floor too high' },
          schemaVersion: 2,
          minSupportedVersion: 3,
          upcasters: { 2: (props) => props },
          properties: {},
        },
      ]),
    ).toThrow(BlockConfigError);

    expect(() =>
      defineBlocks([
        {
          key: 'floorTooLow',
          editor: { label: 'Floor too low' },
          schemaVersion: 2,
          minSupportedVersion: 0,
          upcasters: { 2: (props) => props },
          properties: {},
        },
      ]),
    ).toThrow(BlockConfigError);
  });

  it("resolves an omitted widget to the field type's own defaultWidget", () => {
    const [definition] = defineBlocks([
      {
        key: 'withDefaultWidget',
        editor: { label: 'Widget default' },
        schemaVersion: 1,
        properties: {
          text: { fieldType: 'short_text', label: 'Text', options: {} },
        },
      },
    ]);
    expect(definition?.properties.text?.widget).toBe('text-input');
  });

  it('refuses a widget not in getFieldTypeWidgets(fieldType)', () => {
    expect(() =>
      defineBlocks([
        {
          key: 'badWidget',
          editor: { label: 'Bad widget' },
          schemaVersion: 1,
          properties: {
            text: {
              fieldType: 'short_text',
              label: 'Text',
              options: {},
              widget: 'not-a-real-widget',
            },
          },
        },
      ]),
    ).toThrow(BlockConfigError);
  });

  it("lets a property declare a host field type registered through registerHostFieldType, validated through that type's own value schema", () => {
    registerHostFieldType([starRatingFieldType]);

    const [definition] = defineBlocks([
      {
        key: 'ratingBlock',
        editor: { label: 'Rating' },
        schemaVersion: 1,
        properties: {
          score: {
            fieldType: 'star_rating_r1',
            label: 'Score',
            options: { max: 10 },
          },
        },
      },
    ]);
    expect(definition?.properties.score?.widget).toBe('stars');

    const valid = validateBlockProps(getBlockDefinition('ratingBlock'), {
      score: 7,
    });
    expect(valid.score).toBe(7);

    expect(() =>
      validateBlockProps(getBlockDefinition('ratingBlock'), { score: 99 }),
    ).toThrow('invalid block props');
  });

  it('accepts a host widget registered against a built-in field type for a block property', () => {
    registerHostWidget([
      { fieldType: 'short_text', widget: 'branded-input-r1' },
    ]);

    expect(() =>
      defineBlocks([
        {
          key: 'brandedInputBlock',
          editor: { label: 'Branded input' },
          schemaVersion: 1,
          properties: {
            text: {
              fieldType: 'short_text',
              label: 'Text',
              options: {},
              widget: 'branded-input-r1',
            },
          },
        },
      ]),
    ).not.toThrow();
  });

  it('throws UnknownBlockTypeError for a key never registered', () => {
    expect(() => getBlockDefinition('does-not-exist')).toThrow(
      UnknownBlockTypeError,
    );
  });
});
