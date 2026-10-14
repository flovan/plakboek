import { describe, expect, it } from 'vitest';
import {
  choiceLabel,
  controlFor,
  instantToLocalInput,
  localInputToInstant,
  parseJsonInput,
  subFieldsOf,
  valueSummary,
  type ControlKind,
} from '../../src/client/session/control-map.js';

const source = (
  widget: string,
  fieldType = 'short_text',
  options: unknown = {},
) => ({ fieldType, widget, options });

describe('controlFor', () => {
  it.each<[string, string, ControlKind]>([
    ['text-input', 'short_text', 'text'],
    ['url-input', 'url', 'url'],
    ['slug-input', 'slug', 'slug'],
    ['textarea', 'long_text', 'textarea'],
    ['number-input', 'number', 'number'],
    ['slider', 'integer', 'range'],
    ['checkbox', 'boolean', 'checkbox'],
    ['switch', 'boolean', 'switch'],
    ['dropdown', 'select', 'select'],
    ['radio', 'select', 'radio'],
    ['checkbox-group', 'multi_select', 'checkbox-group'],
    ['multi-dropdown', 'multi_select', 'checkbox-group'],
    ['datetime-picker', 'date_time', 'datetime'],
    ['date-picker', 'date_time', 'date'],
    ['json-editor', 'json', 'json'],
    ['repeater-list', 'repeater', 'repeater'],
    ['rich-text-editor', 'rich_text', 'note-rich-text'],
    ['image-picker', 'image', 'note-media'],
    ['file-picker', 'file', 'note-media'],
    ['entry-picker', 'reference', 'note-entry'],
  ])('maps the %s widget to the %s control kind', (widget, fieldType, kind) => {
    const control = controlFor(source(widget, fieldType));
    expect(control.kind).toBe(kind);
    expect(control.customWidget).toBe(false);
  });

  it('gives a widget it does not know the JSON control and says it is custom', () => {
    const control = controlFor(source('host-colour-wheel', 'host_colour'));
    expect(control.kind).toBe('json');
    expect(control.customWidget).toBe(true);
  });

  it('draws a date-only field as a date even under the date-time widget', () => {
    expect(
      controlFor(source('datetime-picker', 'date_time', { mode: 'date' })).kind,
    ).toBe('date');
  });

  it('reads hints from the options and steps an integer by one', () => {
    expect(
      controlFor(source('text-input', 'short_text', { maxLength: 40 })).hints,
    ).toEqual({ maxLength: 40 });
    expect(
      controlFor(source('number-input', 'integer', { min: 0, max: 10 })).hints,
    ).toEqual({ min: 0, max: 10, step: 1 });
    expect(
      controlFor(source('number-input', 'number', { min: 0.5 })).hints,
    ).toEqual({ min: 0.5 });
  });

  it('lists choices with their English label, and only the allowed ones when narrowed', () => {
    const options = {
      choices: [
        { value: 'a', labels: { en: 'Alpha', nl: 'Alfa' } },
        { value: 'b', labels: { nl: 'Beta' } },
        { value: 'c', labels: {} },
      ],
    };
    expect(controlFor(source('dropdown', 'select', options)).choices).toEqual([
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
      { value: 'c', label: 'c' },
    ]);
    expect(
      controlFor({
        ...source('radio', 'select', options),
        constraint: 'narrowed',
        allowedValues: ['b', 'c'],
      }).choices.map((choice) => choice.value),
    ).toEqual(['b', 'c']);
  });
});

describe('choiceLabel', () => {
  it('prefers English, then the first label, then the value', () => {
    expect(choiceLabel({ nl: 'Een', en: 'One' }, 'one')).toBe('One');
    expect(choiceLabel({ nl: 'Een' }, 'one')).toBe('Een');
    expect(choiceLabel(undefined, 'one')).toBe('one');
  });
});

describe('parseJsonInput', () => {
  it('parses what is JSON and refuses what is not', () => {
    expect(parseJsonInput('{"a":[1,2]}')).toEqual({
      ok: true,
      value: { a: [1, 2] },
    });
    expect(parseJsonInput('null')).toEqual({ ok: true, value: null });
    expect(parseJsonInput('{a:')).toEqual({ ok: false });
  });
});

describe('subFieldsOf', () => {
  it('gives each sub-field the widget it declares, or its field type default', () => {
    const fields = subFieldsOf({
      fields: [
        { key: 'label', label: 'Label', fieldType: 'short_text' },
        {
          key: 'on',
          label: 'On',
          fieldType: 'boolean',
          widget: 'switch',
          required: true,
        },
      ],
    });
    expect(fields.map((field) => controlFor(field.source).kind)).toEqual([
      'text',
      'switch',
    ]);
    expect(fields[1]?.required).toBe(true);
  });
});

describe('date and value helpers', () => {
  it('round-trips an instant through the local input text', () => {
    const instant = new Date(2026, 9, 14, 10, 30).toISOString();
    expect(instantToLocalInput(instant)).toBe('2026-10-14T10:30');
    expect(localInputToInstant('2026-10-14T10:30')).toBe(instant);
    expect(localInputToInstant('')).toBeUndefined();
    expect(instantToLocalInput(undefined)).toBe('');
  });

  it('summarises a read-only value as none, an id or a list of ids', () => {
    expect(valueSummary(undefined, 'None')).toBe('None');
    expect(valueSummary([], 'None')).toBe('None');
    expect(valueSummary('asset_1', 'None')).toBe('asset_1');
    expect(valueSummary(['a', 'b'], 'None')).toBe('a, b');
  });
});
