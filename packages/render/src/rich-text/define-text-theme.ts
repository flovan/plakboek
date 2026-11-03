/**
 * `defineTextTheme`: the host's one declaration of how rich text looks. The
 * data half (marks, nodes, palettes, ...) is the `@plakboek/content` text
 * theme; the optional `renderers` half overrides single entries of the
 * default renderer map.
 */
import {
  resolveTextTheme,
  TextThemeError,
  type TextTheme,
  type TextThemeInput,
  type TextThemeIssue,
} from '@plakboek/content/rich-text';
import { DEFAULT_TEXT_RENDERERS, type TextRenderers } from './renderers.js';

export type {
  LinkTarget,
  TextTheme,
  TextThemeInput,
  TextThemeNarrowing,
} from '@plakboek/content/rich-text';

export type TextThemeDefinitionInput = TextThemeInput & {
  /** Replaces single entries of the default renderer map. */
  readonly renderers?: Partial<TextRenderers>;
};

export type TextThemeDefinition = {
  readonly theme: TextTheme;
  readonly renderers: TextRenderers;
};

/**
 * Registered globally so a definition made by one copy of this package is
 * still recognised by another copy that ends up in the same bundle.
 */
const DEFINITION_BRAND = Symbol.for('plakboek.render.textThemeDefinition');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainFunction(value: unknown): boolean {
  return (
    typeof value === 'function' &&
    !Function.prototype.toString.call(value).startsWith('class')
  );
}

function checkRenderers(
  value: unknown,
  issues: TextThemeIssue[],
): Partial<TextRenderers> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    issues.push({
      code: 'INVALID_SHAPE',
      message: 'renderers must be an object',
    });
    return {};
  }
  const accepted: Record<string, unknown> = {};
  for (const [key, renderer] of Object.entries(value)) {
    if (!Object.hasOwn(DEFAULT_TEXT_RENDERERS, key)) {
      issues.push({
        code: 'INVALID_SHAPE',
        message: `renderers names "${key.slice(0, 64)}", which is not one of ${Object.keys(DEFAULT_TEXT_RENDERERS).join(', ')}`,
      });
      continue;
    }
    if (!isPlainFunction(renderer)) {
      issues.push({
        code: 'INVALID_SHAPE',
        message: `renderers.${key} must be a function`,
      });
      continue;
    }
    accepted[key] = renderer;
  }
  return accepted as Partial<TextRenderers>;
}

/**
 * Resolve the theme data, merge the renderer overrides over the defaults and
 * freeze the result. Every problem is collected before `TextThemeError` is
 * thrown, so a developer fixes a definition in one pass.
 */
export function defineTextTheme(
  input?: TextThemeDefinitionInput,
): TextThemeDefinition {
  if (input !== undefined && !isRecord(input)) {
    // Not an object: the data resolver owns the refusal and its wording.
    resolveTextTheme(input);
  }
  const { renderers, ...themeInput } = input ?? {};
  const issues: TextThemeIssue[] = [];

  let theme: TextTheme | undefined;
  try {
    theme = resolveTextTheme(themeInput);
  } catch (error) {
    if (!(error instanceof TextThemeError)) throw error;
    issues.push(...error.issues);
  }
  const overrides = checkRenderers(renderers, issues);
  if (issues.length > 0 || theme === undefined) {
    throw new TextThemeError(issues);
  }

  const definition: TextThemeDefinition = {
    theme,
    renderers: Object.freeze({ ...DEFAULT_TEXT_RENDERERS, ...overrides }),
  };
  Object.defineProperty(definition, DEFINITION_BRAND, { value: true });
  return Object.freeze(definition);
}

/** True for a value `defineTextTheme` returned. */
export function isTextThemeDefinition(
  value: unknown,
): value is TextThemeDefinition {
  return isRecord(value) && Reflect.get(value, DEFINITION_BRAND) === true;
}
