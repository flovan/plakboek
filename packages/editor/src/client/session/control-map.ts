/**
 * Which control the Properties panel draws for a property, decided from the
 * property's widget and options alone. Every widget of the field-type
 * registry has a control. A widget the editor has no control for (a host's
 * own) gets the standard control of its field type, and a note saying a
 * standard field stands in; only a field type with no standard control gets
 * the JSON control. The HTML attributes a control gets
 * from the options are hints for the browser: the server decides what is
 * valid, so nothing here validates a value.
 */
import type { CatalogueProperty } from '../../api-types.js';

export type ControlKind =
  | 'text'
  | 'url'
  | 'slug'
  | 'textarea'
  | 'number'
  | 'range'
  | 'checkbox'
  | 'switch'
  | 'select'
  | 'radio'
  | 'checkbox-group'
  | 'datetime'
  | 'date'
  | 'json'
  | 'repeater'
  | 'note-rich-text'
  | 'note-media'
  | 'note-entry';

export type ControlChoice = { readonly value: string; readonly label: string };

export type ControlHints = {
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
};

export type ControlDescriptor = {
  readonly kind: ControlKind;
  readonly hints: ControlHints;
  readonly choices: readonly ControlChoice[];
  /** The widget is not one the editor knows: its field type's standard control, or the JSON control, stands in for it. */
  readonly customWidget: boolean;
};

/** What `controlFor` reads: a catalogue property, or a repeater's sub-field made to look like one. */
export type ControlSource = Pick<
  CatalogueProperty,
  'fieldType' | 'widget' | 'options'
> &
  Partial<Pick<CatalogueProperty, 'constraint' | 'allowedValues'>>;

const KIND_BY_WIDGET: Readonly<Record<string, ControlKind>> = {
  'text-input': 'text',
  'url-input': 'url',
  'slug-input': 'slug',
  textarea: 'textarea',
  'number-input': 'number',
  slider: 'range',
  checkbox: 'checkbox',
  switch: 'switch',
  dropdown: 'select',
  radio: 'radio',
  'checkbox-group': 'checkbox-group',
  'multi-dropdown': 'checkbox-group',
  'datetime-picker': 'datetime',
  'date-picker': 'date',
  'json-editor': 'json',
  'repeater-list': 'repeater',
  'rich-text-editor': 'note-rich-text',
  'image-picker': 'note-media',
  'file-picker': 'note-media',
  'entry-picker': 'note-entry',
};

/** The widget a field type uses when a declaration names none, for a repeater's sub-fields. */
const DEFAULT_WIDGET: Readonly<Record<string, string>> = {
  short_text: 'text-input',
  long_text: 'textarea',
  rich_text: 'rich-text-editor',
  number: 'number-input',
  integer: 'number-input',
  boolean: 'checkbox',
  date_time: 'datetime-picker',
  select: 'dropdown',
  multi_select: 'checkbox-group',
  image: 'image-picker',
  file: 'file-picker',
  reference: 'entry-picker',
  json: 'json-editor',
  slug: 'slug-input',
  url: 'url-input',
  repeater: 'repeater-list',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/** The label to show for a choice: English, else the first label given, else the value. */
export function choiceLabel(
  labels: Readonly<Record<string, string>> | undefined,
  value: string,
): string {
  if (labels === undefined) return value;
  const english = labels['en'];
  if (typeof english === 'string' && english !== '') return english;
  const first = Object.values(labels).find(
    (label) => typeof label === 'string' && label !== '',
  );
  return first ?? value;
}

function choicesOf(source: ControlSource): readonly ControlChoice[] {
  if (!isRecord(source.options)) return [];
  const raw = source.options['choices'];
  if (!Array.isArray(raw)) return [];
  const allowed =
    source.constraint === 'narrowed' && source.allowedValues !== undefined
      ? new Set(source.allowedValues)
      : null;
  const choices: ControlChoice[] = [];
  for (const entry of raw as unknown[]) {
    if (!isRecord(entry) || typeof entry['value'] !== 'string') continue;
    const value = entry['value'];
    if (allowed !== null && !allowed.has(value)) continue;
    const labels = isRecord(entry['labels'])
      ? (entry['labels'] as Record<string, string>)
      : undefined;
    choices.push({ value, label: choiceLabel(labels, value) });
  }
  return choices;
}

function hintsOf(kind: ControlKind, source: ControlSource): ControlHints {
  const options = isRecord(source.options) ? source.options : {};
  const maxLength = numberOf(options['maxLength']);
  const min = numberOf(options['min']);
  const max = numberOf(options['max']);
  return {
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(kind === 'number' || kind === 'range'
      ? {
          ...(min === undefined ? {} : { min }),
          ...(max === undefined ? {} : { max }),
          ...(source.fieldType === 'integer' ? { step: 1 } : {}),
        }
      : {}),
  };
}

/** The control for a property, with the hints, the choices it offers and whether the widget is custom. */
export function controlFor(source: ControlSource): ControlDescriptor {
  const own = KIND_BY_WIDGET[source.widget];
  // A widget the editor has no control for is drawn as its field type's standard one.
  const standIn =
    own === undefined ? DEFAULT_WIDGET[source.fieldType] : undefined;
  const known =
    own ?? (standIn === undefined ? undefined : KIND_BY_WIDGET[standIn]);
  const isDateOnly =
    isRecord(source.options) && source.options['mode'] === 'date';
  const kind: ControlKind =
    known === 'datetime' && isDateOnly ? 'date' : (known ?? 'json');
  return {
    kind,
    hints: hintsOf(kind, source),
    choices:
      kind === 'select' || kind === 'radio' || kind === 'checkbox-group'
        ? choicesOf(source)
        : [],
    customWidget: own === undefined,
  };
}

/** Typographic double quotes a system may substitute for the straight one an editor typed. */
const TYPOGRAPHIC_QUOTES = /[\u201c\u201d\u201e\u201f\u2033]/g;

/**
 * Reads what an editor typed into a JSON control; nothing here judges the
 * value beyond its syntax. Text that is JSON is never rewritten. Text that is
 * not is tried once more with typographic double quotes read as straight ones,
 * because a system that substitutes them breaks the quotes a string needs.
 */
export function parseJsonInput(
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    // fall through to the straight-quote reading
  }
  try {
    return {
      ok: true,
      value: JSON.parse(text.replace(TYPOGRAPHIC_QUOTES, '"')) as unknown,
    };
  } catch {
    return { ok: false };
  }
}

/** One field of a repeater's rows. */
export type SubField = {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly source: ControlSource;
};

/** The sub-fields a repeater declares, each with the widget it will be drawn with. */
export function subFieldsOf(options: unknown): readonly SubField[] {
  if (!isRecord(options) || !Array.isArray(options['fields'])) return [];
  const fields: SubField[] = [];
  for (const raw of options['fields'] as unknown[]) {
    if (!isRecord(raw)) continue;
    const { key, label, fieldType, widget } = raw;
    if (typeof key !== 'string' || typeof fieldType !== 'string') continue;
    fields.push({
      key,
      label: typeof label === 'string' ? label : key,
      required: raw['required'] === true,
      source: {
        fieldType,
        widget:
          typeof widget === 'string'
            ? widget
            : (DEFAULT_WIDGET[fieldType] ?? ''),
        options: raw['options'] ?? {},
      },
    });
  }
  return fields;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** An instant (ISO text) as the `datetime-local` input shows it: the editor's own local time. */
export function instantToLocalInput(value: unknown): string {
  if (typeof value !== 'string') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** What a `datetime-local` input holds, as the instant the field stores; nothing for an empty input. */
export function localInputToInstant(text: string): string | undefined {
  if (text === '') return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** What a read-only picker shows of its value: "None", the asset id, or the value as text. */
export function valueSummary(value: unknown, none: string): string {
  if (value === undefined || value === null || value === '') return none;
  if (Array.isArray(value) && value.length === 0) return none;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item: unknown) => (typeof item === 'string' ? item : ''))
      .filter((item) => item !== '')
      .join(', ');
  }
  if (isRecord(value) && typeof value['id'] === 'string') return value['id'];
  return JSON.stringify(value);
}
