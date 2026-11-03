/**
 * The render environment of rich text: which theme and renderers to use,
 * whether this is a visitor page or the editor frame, how a page id becomes a
 * path, and where issues go. A host creates one per render (so reports are
 * once per render) and provides it with `TextEnvironmentProvider`; without a
 * provider every `RichText` renders with the default theme in visitor mode.
 *
 * This module is on the client-safe root entry, so it reports through its own
 * contained call rather than the server-side hook plumbing.
 */
import {
  createContext,
  createElement,
  useContext,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { TextTheme } from '@plakboek/content/rich-text';
import type { RenderHooks, RichTextIssueEvent } from '../hooks.js';
import {
  defineTextTheme,
  type TextThemeDefinition,
} from './define-text-theme.js';
import type { TextRenderers } from './renderers.js';

export type TextEnvironmentMode = 'visitor' | 'edit';

export type TextEnvironmentInput = {
  /** Defaults to `defineTextTheme()`. */
  readonly definition?: TextThemeDefinition;
  /** Defaults to `'visitor'`. */
  readonly mode?: TextEnvironmentMode;
  /** The public path of a page id, or `null` when it cannot be resolved. */
  readonly resolvePage?: (pageId: string) => string | null;
  readonly hooks?: Pick<RenderHooks, 'onRichTextIssue'>;
};

export type TextEnvironment = {
  readonly theme: TextTheme;
  readonly renderers: TextRenderers;
  readonly mode: TextEnvironmentMode;
  readonly resolvePage: (pageId: string) => string | null;
  /** Reports an issue once per environment and kind and name. */
  readonly report: (event: RichTextIssueEvent) => void;
};

/** An environment holds at most this many distinct reports. */
const MAX_REPORTS = 100;

let defaultDefinition: TextThemeDefinition | undefined;

function noPage(): null {
  return null;
}

function logIssue(event: RichTextIssueEvent): void {
  // oxlint-disable-next-line no-console -- default fallback when the host supplies no rich-text hook; carries the type name only
  console.error('[@plakboek/render] onRichTextIssue', event);
}

/** Calls the hook (or the logging fallback); a throw or rejection is contained. */
function deliver(
  hook: ((event: RichTextIssueEvent) => void) | undefined,
  event: RichTextIssueEvent,
): void {
  try {
    const returned: unknown = (hook ?? logIssue)(event);
    if (
      typeof returned === 'object' &&
      returned !== null &&
      typeof Reflect.get(returned, 'then') === 'function'
    ) {
      void Promise.resolve(returned).catch(() => undefined);
    }
  } catch {
    // A broken hook never breaks rendering.
  }
}

export function createTextEnvironment(
  input: TextEnvironmentInput = {},
): TextEnvironment {
  defaultDefinition ??= defineTextTheme();
  const definition = input.definition ?? defaultDefinition;
  const hook = input.hooks?.onRichTextIssue;
  const seen = new Set<string>();
  return Object.freeze({
    theme: definition.theme,
    renderers: definition.renderers,
    mode: input.mode ?? 'visitor',
    resolvePage: input.resolvePage ?? noPage,
    report: (event: RichTextIssueEvent): void => {
      const id = `${event.kind}:${event.name}`;
      if (seen.has(id) || seen.size >= MAX_REPORTS) return;
      seen.add(id);
      deliver(hook, event);
    },
  });
}

const TextEnvironmentContext = createContext<TextEnvironment | null>(null);

export type TextEnvironmentProviderProps = {
  readonly environment: TextEnvironment;
  readonly children?: ReactNode;
};

export function TextEnvironmentProvider({
  environment,
  children,
}: TextEnvironmentProviderProps): ReactElement {
  return createElement(
    TextEnvironmentContext.Provider,
    { value: environment },
    children,
  );
}

/**
 * The provided environment, or a fresh default one (default theme, visitor
 * mode) so a field rendered outside any provider still works.
 */
export function useTextEnvironment(): TextEnvironment {
  return useContext(TextEnvironmentContext) ?? createTextEnvironment();
}
