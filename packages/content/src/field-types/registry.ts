/**
 * The field-type validation registry (FIELD-02, FIELD-04, FIELD-06): one
 * record per field type, each with its own options schema and a
 * value-schema builder. Mirrors `@plakboek/permissions`'s catalogue.ts
 * shape (a frozen, keyed source of truth) for the flat `FIELD_TYPES` tuple;
 * the per-type record itself is a new problem shape for this codebase (a
 * zod-backed discriminated registry), not copied from any prior file.
 *
 * `field_type`'s storage type never changes after creation (D-08) and is
 * kept apart from its presentational `widget` (FIELD-04): a widget is only
 * ever one of the type's own declared `widgets`.
 *
 * EXT-02 (D-07): `content_type_fields_field_type_check` in `0002_content_engine`
 * still bounds `content_type_fields.field_type` to the sixteen built-ins
 * below -- that CHECK constraint is unchanged by host registration. A host
 * field type registered through `registerHostFieldType` is validated only in
 * the application layer, by `getFieldTypeDefinition` resolving its key; it
 * is never a legal value for a `content_type_fields` row. Storage that has
 * no such CHECK (e.g. `@plakboek/pages`'s block properties) is exactly where
 * a host field type's key is meant to be stored.
 */
import type { z } from 'zod';
import { reportContentWarning } from '../config.js';
import { booleanFieldType } from './boolean.js';
import { dateTimeFieldType } from './date-time.js';
import { FIELD_TYPES, isFieldType, type FieldType } from './field-type-ids.js';
import { fileFieldType } from './file.js';
import { imageFieldType } from './image.js';
import { integerFieldType } from './integer.js';
import { jsonFieldType } from './json.js';
import { longTextFieldType } from './long-text.js';
import { multiSelectFieldType } from './multi-select.js';
import { numberFieldType } from './number.js';
import { referenceFieldType } from './reference.js';
import { repeaterFieldType } from './repeater.js';
import { richTextFieldType } from './rich-text.js';
import { selectFieldType } from './select.js';
import { shortTextFieldType } from './short-text.js';
import { slugFieldFieldType } from './slug-field.js';
import { urlFieldType } from './url.js';

/** The 16 field types (FIELD-02), in the same order as
 * `content_type_fields_field_type_check` in `0002_content_engine`.
 * Declared in `field-type-ids.ts`, re-exported here so every existing
 * import of this module keeps working unchanged. See that module's header
 * comment for why `schema.ts` reads `FIELD_TYPES` from there directly
 * instead of from here. */
export { FIELD_TYPES, isFieldType };
export type { FieldType };

/** One field type's contract: how its per-field `options` are validated,
 * how a submitted value is validated against those options, what an "empty"
 * value looks like (for the D-12 required check), and which widgets it
 * supports. */
export type FieldTypeDefinition<O = unknown> = {
  readonly fieldType: FieldType;
  readonly optionsSchema: z.ZodType<O>;
  buildValueSchema(options: O): z.ZodType;
  isEmptyValue(value: unknown): boolean;
  readonly widgets: readonly [string, ...string[]];
  readonly defaultWidget: string;
  readonly allowedInRepeater: boolean;
};

/** A host's own field type contract (EXT-02, D-07): identical to
 * `FieldTypeDefinition`, except `fieldType` is a plain `string` -- a host
 * type's key is never one of the sixteen values in `FieldType`. The
 * registry's internal map and `getFieldTypeDefinition` operate on this wider
 * type so a single lookup path serves both a built-in and a host
 * registration; `FieldTypeDefinition` itself is unchanged and stays the
 * shape every built-in module exports. */
export type HostFieldTypeDefinition<O = unknown> = {
  readonly fieldType: string;
  readonly optionsSchema: z.ZodType<O>;
  buildValueSchema(options: O): z.ZodType;
  isEmptyValue(value: unknown): boolean;
  readonly widgets: readonly [string, ...string[]];
  readonly defaultWidget: string;
  readonly allowedInRepeater: boolean;
};

/** Every field type in `FIELD_TYPES` must have a definition, filed under its
 * own key. Checked with `satisfies`, never an annotation, so a definition
 * keeps its own literal `widgets` and options type instead of being widened
 * to this constraint's shape. */
export type FieldTypeDefinitions = {
  readonly [K in FieldType]: FieldTypeDefinition<unknown> & {
    readonly fieldType: K;
  };
};

// Keyed by plain `string` (not `FieldType`) so lookups never need to widen a
// caller-supplied string into the branded union before the membership check
// below has actually confirmed it belongs to it. Holds `HostFieldTypeDefinition`
// (the wider shape) so the same map and the same lookup serve both the
// sixteen built-ins and a host registration; a `FieldTypeDefinition` is
// always assignable into it since `FieldType` is a subtype of `string`.
const registry = new Map<string, HostFieldTypeDefinition<unknown>>();

/**
 * Registers a field type's definition -- a built-in from the loop below, or
 * a host definition from `registerHostFieldType`, which validates first.
 * Never exported from the package barrel: the only public door onto this
 * function is `registerHostFieldType`.
 */
export function registerFieldType(
  definition: HostFieldTypeDefinition<unknown>,
): void {
  registry.set(definition.fieldType, definition);
}

/** One definition per field type, keyed by its own `fieldType` and checked
 * by `FieldTypeDefinitions` above. This is the single record every other
 * derived copy (`options-map.ts`'s two maps, this module's own registration
 * loop) reads through, so adding a field type here is the only hand edit a
 * 17th type needs on this side of the drift assertion in
 * `schema-parity.test.ts`.
 *
 * Each field-type module exports a plain `FieldTypeDefinition` object and
 * imports only the type of `FieldTypeDefinition` back from this module,
 * erased at compile time and never a value, so reading them here carries no
 * circular-import risk. `repeater.ts` is the one exception: it needs
 * `getFieldTypeDefinition` as a real value to resolve its sub-fields, but
 * only calls it from inside its own functions, never at its own module top
 * level. See `repeater.ts`'s header comment. */
export const FIELD_TYPE_DEFINITIONS = {
  short_text: shortTextFieldType,
  long_text: longTextFieldType,
  rich_text: richTextFieldType,
  number: numberFieldType,
  integer: integerFieldType,
  boolean: booleanFieldType,
  date_time: dateTimeFieldType,
  select: selectFieldType,
  multi_select: multiSelectFieldType,
  image: imageFieldType,
  file: fileFieldType,
  reference: referenceFieldType,
  json: jsonFieldType,
  slug: slugFieldFieldType,
  url: urlFieldType,
  repeater: repeaterFieldType,
} satisfies FieldTypeDefinitions;

for (const definition of Object.values(FIELD_TYPE_DEFINITIONS)) {
  registerFieldType(definition);
}

/** Thrown when a `field_type` string has no registered definition -- a
 * value the database CHECK constraint allows but this build's field-type
 * registry does not (yet) implement. */
export class UnknownFieldTypeError extends Error {
  readonly fieldType: string;

  constructor(fieldType: string) {
    super(`@plakboek/content: field type "${fieldType}" is not registered`);
    this.name = 'UnknownFieldTypeError';
    this.fieldType = fieldType;
  }
}

/** Thrown for a collect-then-throw-once set of definition-shaped problems:
 * a field's `options` failing their type's `optionsSchema` (`context` names
 * the field type), or a generated field key coming out empty (`context`
 * names `"field key"`). */
export class FieldDefinitionError extends Error {
  readonly issues: readonly string[];

  constructor(context: string, issues: readonly string[]) {
    super([`@plakboek/content: invalid ${context}:`, ...issues].join('\n'));
    this.name = 'FieldDefinitionError';
    this.issues = issues;
  }
}

export function getFieldTypeDefinition(
  fieldType: string,
): HostFieldTypeDefinition<unknown> {
  const definition = registry.get(fieldType);
  if (definition === undefined) {
    throw new UnknownFieldTypeError(fieldType);
  }
  return definition;
}

/** Validates `options` against `fieldType`'s `optionsSchema` and returns the
 * parsed, typed result. Throws `FieldDefinitionError` naming every zod
 * issue's message on failure. */
export function parseFieldOptions(
  fieldType: FieldType,
  options: unknown,
): unknown {
  const definition = getFieldTypeDefinition(fieldType);
  const result = definition.optionsSchema.safeParse(options);
  if (!result.success) {
    throw new FieldDefinitionError(
      `options for field type "${fieldType}"`,
      result.error.issues.map((issue) => issue.message),
    );
  }
  return result.data;
}

// -- Host field-type registration (EXT-02, D-07) ---------------------------
//
// `registerHostFieldType` is the validating public door this module keeps
// closed on `registerFieldType` above: a host never registers or overwrites
// a type without every definition in the call first passing the checks
// below, collected together and thrown once. `getFieldTypeWidgets` is the
// single resolver every widget-membership check in `fields.ts`/`seed.ts`
// reads, so a host-registered widget (via `widgets.ts`'s
// `registerHostWidget`) is indistinguishable from a built-in one at every
// call site that matters.

/** Allowed shape of a host field type's own key: lowercase, starting with a
 * letter, matching the `field_type text` column's own character budget. */
export const HOST_FIELD_TYPE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export type HostRegistrationIssueCode =
  | 'INVALID_KEY'
  | 'EMPTY_WIDGETS'
  | 'DEFAULT_WIDGET_NOT_IN_WIDGETS'
  | 'DUPLICATE_WIDGET'
  | 'UNKNOWN_FIELD_TYPE'
  | 'MISSING_HOOK';

/** One problem found while registering a host field type or a host widget
 * (`widgets.ts` reuses this same shape). */
export type HostRegistrationIssue = {
  readonly code: HostRegistrationIssueCode;
  readonly value?: string;
  readonly message: string;
};

/** Thrown by `registerHostFieldType` and `widgets.ts`'s `registerHostWidget`
 * with every problem found across the whole call, collected before throwing
 * once -- the same collect-then-throw shape as `ContentConfigError`. */
export class HostRegistrationError extends Error {
  readonly issues: readonly HostRegistrationIssue[];

  constructor(issues: readonly HostRegistrationIssue[]) {
    super(
      [
        '[@plakboek/content] invalid host registration:',
        ...issues.map((issue) => issue.message),
      ].join('\n'),
    );
    this.name = 'HostRegistrationError';
    this.issues = issues;
  }
}

/** Emitted when a host registration overwrites a key already held by one of
 * the sixteen built-in field types (D-05): permitted, but never silent. */
export type ShadowedFieldTypeEvent = {
  readonly fieldType: string;
  readonly occurredAt: Date;
};

function defaultOnShadowedFieldType(event: ShadowedFieldTypeEvent): void {
  // oxlint-disable-next-line no-console -- documented default fallback hook (D-05); a host overrides onShadowedFieldType to route elsewhere
  console.warn(
    `[@plakboek/content] host field type registration shadows built-in field type "${event.fieldType}"`,
  );
}

/**
 * Registers one or more host field types (EXT-02, D-07). Collects every
 * problem across the whole array -- a key failing
 * `HOST_FIELD_TYPE_KEY_PATTERN`, an empty `widgets`, a `defaultWidget`
 * absent from `widgets`, or a duplicate widget string within one
 * definition's own `widgets` -- and throws exactly one `HostRegistrationError`
 * naming all of them. On success, registers each definition in array order,
 * so a later entry with the same key overwrites an earlier one (D-05):
 * array order alone decides, there is no hidden precedence table. Before
 * overwriting a key already held by a built-in, fires `onShadowedFieldType`
 * (or the console-warning default) -- shadowing is allowed, never silent.
 * Registration is process-local, boot-time and in-memory: nothing here is
 * ever persisted or crosses a process boundary.
 */
export function registerHostFieldType(
  definitions: readonly HostFieldTypeDefinition[],
  options?: {
    readonly onShadowedFieldType?: (event: ShadowedFieldTypeEvent) => void;
  },
): void {
  const issues: HostRegistrationIssue[] = [];

  for (const definition of definitions) {
    if (!HOST_FIELD_TYPE_KEY_PATTERN.test(definition.fieldType)) {
      issues.push({
        code: 'INVALID_KEY',
        value: definition.fieldType,
        message: `host field type key "${definition.fieldType}" must match ${HOST_FIELD_TYPE_KEY_PATTERN.source}`,
      });
    }
    if (definition.widgets.length === 0) {
      issues.push({
        code: 'EMPTY_WIDGETS',
        value: definition.fieldType,
        message: `host field type "${definition.fieldType}" must declare at least one widget`,
      });
    } else if (!definition.widgets.includes(definition.defaultWidget)) {
      issues.push({
        code: 'DEFAULT_WIDGET_NOT_IN_WIDGETS',
        value: definition.fieldType,
        message: `host field type "${definition.fieldType}"'s defaultWidget "${definition.defaultWidget}" is not one of its own widgets`,
      });
    }
    const seenWidgets = new Set<string>();
    for (const widget of definition.widgets) {
      if (seenWidgets.has(widget)) {
        issues.push({
          code: 'DUPLICATE_WIDGET',
          value: widget,
          message: `host field type "${definition.fieldType}" declares widget "${widget}" more than once`,
        });
      }
      seenWidgets.add(widget);
    }
  }

  if (issues.length > 0) {
    throw new HostRegistrationError(issues);
  }

  for (const definition of definitions) {
    if (isFieldType(definition.fieldType)) {
      reportContentWarning(
        options?.onShadowedFieldType,
        defaultOnShadowedFieldType,
        {
          fieldType: definition.fieldType,
          occurredAt: new Date(),
        },
      );
    }
    registerFieldType(definition);
  }
}

// One widget list per host-registered field type, keyed by the widget's own
// name -- a Map preserves insertion order, so re-registering the same
// (fieldType, widget) pair overwrites its stored `component` in place
// without moving its position in `getFieldTypeWidgets`'s returned order.
const hostWidgetsByType = new Map<string, Map<string, unknown>>();

/**
 * Appends one host widget to `fieldType`'s widget list. Called only by
 * `widgets.ts`'s `registerHostWidget`, after it has already confirmed
 * `fieldType` resolves -- not exported from the package barrel.
 */
export function registerHostWidgetEntry(
  fieldType: string,
  widget: string,
  component: unknown,
): void {
  let forType = hostWidgetsByType.get(fieldType);
  if (forType === undefined) {
    forType = new Map();
    hostWidgetsByType.set(fieldType, forType);
  }
  forType.set(widget, component);
}

/**
 * The single resolver every widget-membership check reads (FIELD-04,
 * EXT-02): `fieldType`'s own declared `widgets`, plus every widget
 * registered for it through `registerHostWidget`, deduplicated, definition
 * order first. Throws `UnknownFieldTypeError` for an unregistered type,
 * exactly like `getFieldTypeDefinition`.
 */
export function getFieldTypeWidgets(
  fieldType: string,
): readonly [string, ...string[]] {
  const definition = getFieldTypeDefinition(fieldType);
  const hostWidgets = hostWidgetsByType.get(fieldType);
  if (hostWidgets === undefined || hostWidgets.size === 0) {
    return definition.widgets;
  }
  const seen = new Set<string>(definition.widgets);
  const extra: string[] = [];
  for (const widget of hostWidgets.keys()) {
    if (!seen.has(widget)) {
      extra.push(widget);
      seen.add(widget);
    }
  }
  const [first, ...rest] = definition.widgets;
  return [first, ...rest, ...extra];
}
