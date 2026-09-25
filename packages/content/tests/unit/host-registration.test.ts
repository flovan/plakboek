/**
 * Host field-type and widget registration (EXT-02, D-07): the public door
 * `registerHostFieldType`/`registerHostWidget` open onto the registry that
 * plan 04-04 composes into `definePagesConfig`. Registers under keys no
 * other unit test in this package uses, since the registry is module-level
 * state shared by every test in this file.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  getFieldTypeDefinition,
  getFieldTypeWidgets,
  HostRegistrationError,
  isFieldType,
  registerHostFieldType,
  UnknownFieldTypeError,
  type HostFieldTypeDefinition,
} from '../../src/field-types/registry.js';
import { registerHostWidget } from '../../src/widgets.js';

function colorFieldType(
  overrides: Partial<HostFieldTypeDefinition> = {},
): HostFieldTypeDefinition {
  return {
    fieldType: 'color',
    optionsSchema: z.strictObject({}),
    buildValueSchema: () => z.string().regex(/^#[0-9a-f]{6}$/),
    isEmptyValue: (value) =>
      value === undefined || value === null || value === '',
    widgets: ['color-picker'],
    defaultWidget: 'color-picker',
    allowedInRepeater: true,
    ...overrides,
  };
}

describe('registerHostFieldType (EXT-02, D-07)', () => {
  it('registers a host field type resolvable by getFieldTypeDefinition, not counted in isFieldType', () => {
    registerHostFieldType([colorFieldType({ fieldType: 'host_color_a' })]);
    expect(isFieldType('host_color_a')).toBe(false);
    expect(getFieldTypeDefinition('host_color_a').fieldType).toBe(
      'host_color_a',
    );
  });

  it('collects every problem across the call and throws exactly one HostRegistrationError', () => {
    let caught: unknown;
    try {
      registerHostFieldType([
        colorFieldType({ fieldType: '', widgets: ['color-picker'] }),
        colorFieldType({
          fieldType: 'host_color_b',
          widgets: ['color-picker'],
          defaultWidget: 'swatch',
        }),
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HostRegistrationError);
    const issues = (caught as HostRegistrationError).issues;
    expect(issues.map((issue) => issue.code)).toEqual([
      'INVALID_KEY',
      'DEFAULT_WIDGET_NOT_IN_WIDGETS',
    ]);

    // Neither definition from the throwing call registered -- validation
    // runs to completion before any registration happens.
    expect(() => getFieldTypeDefinition('host_color_b')).toThrow(
      UnknownFieldTypeError,
    );
  });

  it('lets a later entry with the same key overwrite an earlier one -- array order alone decides', () => {
    registerHostFieldType([
      colorFieldType({
        fieldType: 'host_color_c',
        defaultWidget: 'color-picker',
      }),
      colorFieldType({
        fieldType: 'host_color_c',
        widgets: ['swatch'],
        defaultWidget: 'swatch',
      }),
    ]);
    expect(getFieldTypeDefinition('host_color_c').defaultWidget).toBe('swatch');
  });

  it('allows shadowing a built-in field type and reports it once through the warning hook, without throwing', () => {
    const originalShortText = getFieldTypeDefinition('short_text');
    const events: { fieldType: string }[] = [];
    try {
      expect(() =>
        registerHostFieldType(
          [
            colorFieldType({
              fieldType: 'short_text',
              widgets: ['swatch'],
              defaultWidget: 'swatch',
            }),
          ],
          {
            onShadowedFieldType: (event) =>
              events.push({ fieldType: event.fieldType }),
          },
        ),
      ).not.toThrow();
      expect(events).toHaveLength(1);
      expect(events[0]?.fieldType).toBe('short_text');
      expect(getFieldTypeDefinition('short_text').defaultWidget).toBe('swatch');
    } finally {
      registerHostFieldType([originalShortText]);
    }
  });

  it('refuses a host field type declaring allowedInRepeater: false as a repeater sub-field, unchanged', () => {
    registerHostFieldType([
      colorFieldType({ fieldType: 'host_no_repeat', allowedInRepeater: false }),
    ]);
    const repeaterDefinition = getFieldTypeDefinition('repeater');
    const result = repeaterDefinition.optionsSchema.safeParse({
      fields: [{ key: 'swatch', label: 'Swatch', fieldType: 'host_no_repeat' }],
    });
    expect(result.success).toBe(false);
  });

  it('lets a host field type declaring allowedInRepeater: true be used as a repeater sub-field', () => {
    registerHostFieldType([
      colorFieldType({ fieldType: 'host_repeatable', allowedInRepeater: true }),
    ]);
    const repeaterDefinition = getFieldTypeDefinition('repeater');
    const result = repeaterDefinition.optionsSchema.safeParse({
      fields: [
        { key: 'swatch', label: 'Swatch', fieldType: 'host_repeatable' },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('getFieldTypeWidgets / registerHostWidget (EXT-02, D-07)', () => {
  it('resolves the built-in tuple, then also a host widget once registered against short_text', () => {
    expect(getFieldTypeWidgets('short_text')).toEqual(
      getFieldTypeDefinition('short_text').widgets,
    );

    registerHostWidget([{ fieldType: 'short_text', widget: 'color-picker' }]);

    const widgets = getFieldTypeWidgets('short_text');
    expect(widgets).toContain('color-picker');
    expect(
      widgets.slice(0, getFieldTypeDefinition('short_text').widgets.length),
    ).toEqual(getFieldTypeDefinition('short_text').widgets);
  });

  it('throws HostRegistrationError naming the field type for an unregistered fieldType', () => {
    let caught: unknown;
    try {
      registerHostWidget([
        { fieldType: 'not_a_real_field_type', widget: 'swatch-picker' },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HostRegistrationError);
    const issues = (caught as HostRegistrationError).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('UNKNOWN_FIELD_TYPE');
    expect(issues[0]?.value).toBe('not_a_real_field_type');
  });
});
