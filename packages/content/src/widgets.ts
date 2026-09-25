/**
 * Host widget registration (EXT-02, D-07): a host adds an additional widget
 * to an existing field type -- built-in or host-registered -- without
 * editing core. `registerHostWidget` validates first, collect-then-throw
 * with the same `HostRegistrationError` shape `registerHostFieldType` uses,
 * then appends through `field-types/registry.ts`'s `registerHostWidgetEntry`
 * -- the one write path behind `getFieldTypeWidgets`, the single resolver
 * every widget-membership check in `fields.ts`/`seed.ts` reads.
 */
import {
  getFieldTypeDefinition,
  HostRegistrationError,
  registerHostWidgetEntry,
  UnknownFieldTypeError,
  type HostRegistrationIssue,
} from './field-types/registry.js';

/** Allowed shape of a widget's own name: lowercase, starting with a letter,
 * hyphen-separated -- distinct from a field type's own key pattern, which
 * uses underscores. */
const HOST_WIDGET_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** One host widget declared against an existing field type. `component` is
 * stored opaque: this package never renders it, only carries it through --
 * the editor phases resolve what it actually is. */
export type HostWidgetDefinition = {
  readonly fieldType: string;
  readonly widget: string;
  readonly component?: unknown;
};

/**
 * Registers one or more host widgets (EXT-02, D-07). Collects every problem
 * across the whole array -- a widget name failing `HOST_WIDGET_PATTERN`, or
 * a `fieldType` `getFieldTypeDefinition` cannot resolve -- and throws
 * exactly one `HostRegistrationError` naming all of them, never registering
 * a dangling widget for a field type that does not exist. On success,
 * appends each widget to the module-level list `getFieldTypeWidgets` reads,
 * in array order; re-registering the same `(fieldType, widget)` pair
 * overwrites its stored `component` without moving its position.
 */
export function registerHostWidget(
  definitions: readonly HostWidgetDefinition[],
): void {
  const issues: HostRegistrationIssue[] = [];

  for (const definition of definitions) {
    if (!HOST_WIDGET_PATTERN.test(definition.widget)) {
      issues.push({
        code: 'INVALID_KEY',
        value: definition.widget,
        message: `widget "${definition.widget}" must match ${HOST_WIDGET_PATTERN.source}`,
      });
      continue;
    }
    try {
      getFieldTypeDefinition(definition.fieldType);
    } catch (error) {
      if (error instanceof UnknownFieldTypeError) {
        issues.push({
          code: 'UNKNOWN_FIELD_TYPE',
          value: definition.fieldType,
          message: `field type "${definition.fieldType}" is not registered`,
        });
        continue;
      }
      throw error;
    }
  }

  if (issues.length > 0) {
    throw new HostRegistrationError(issues);
  }

  for (const definition of definitions) {
    registerHostWidgetEntry(
      definition.fieldType,
      definition.widget,
      definition.component,
    );
  }
}
