/**
 * Host-code content configuration (D-20) and the dependency bag every
 * engine operation takes. Enabled locales, the default locale and the site
 * timezone are declared in code, exactly like `defineRoles` -- there is no
 * locales table. `defineContentConfig` collects every problem and throws one
 * `ContentConfigError`, following `@plakboek/permissions`'s `RoleConfigError`
 * shape (never fail on the first bad field).
 */
import type { AuditDatabase, AuditRecorder } from '@plakboek/auth';
import type { PermissionResolver } from '@plakboek/permissions';

/** A locale identifier: lowercase BCP-47-style tags (`en`, `nl`, `nl-be`).
 * Mixed-case tags such as `nl-BE` are rejected rather than normalised
 * (I18N-04, flagged as an unclassified assumption in 03-02-PLAN.md). */
export const LOCALE_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;

export type ContentConfig = {
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly timezone: string;
};

export type ContentConfigIssueCode =
  | 'NO_LOCALES'
  | 'INVALID_LOCALE'
  | 'DUPLICATE_LOCALE'
  | 'DEFAULT_LOCALE_NOT_ENABLED'
  | 'INVALID_TIMEZONE';

export type ContentConfigIssue = {
  readonly code: ContentConfigIssueCode;
  readonly value?: string;
  readonly message: string;
};

/** Thrown by `defineContentConfig` with every problem found in the host's
 * config, collected before throwing once. */
export class ContentConfigError extends Error {
  readonly issues: readonly ContentConfigIssue[];

  constructor(issues: readonly ContentConfigIssue[]) {
    super(
      [
        '[@plakboek/content] invalid content config:',
        ...issues.map((issue) => issue.message),
      ].join('\n'),
    );
    this.name = 'ContentConfigError';
    this.issues = issues;
  }
}

function isValidTimezone(timezone: string): boolean {
  try {
    // Constructing throws RangeError for an unrecognized IANA zone -- that
    // is the check itself.
    const formatter = new Intl.DateTimeFormat('en', { timeZone: timezone });
    return formatter.resolvedOptions().timeZone !== undefined;
  } catch {
    return false;
  }
}

/**
 * Validates and freezes a host's content config. Throws a single
 * `ContentConfigError` listing every problem found (empty/duplicate/
 * malformed locales, a default locale not among them, an unrecognized
 * timezone); on success returns a frozen copy with a frozen locale array.
 */
export function defineContentConfig(input: ContentConfig): ContentConfig {
  const issues: ContentConfigIssue[] = [];
  const locales = Array.isArray(input.locales) ? input.locales : [];

  if (locales.length === 0) {
    issues.push({
      code: 'NO_LOCALES',
      message: 'content config must declare at least one locale',
    });
  }

  const seen = new Set<string>();
  for (const locale of locales) {
    if (!LOCALE_PATTERN.test(locale)) {
      issues.push({
        code: 'INVALID_LOCALE',
        value: locale,
        message: `locale "${locale}" must match ${LOCALE_PATTERN.source}`,
      });
      continue;
    }
    if (seen.has(locale)) {
      issues.push({
        code: 'DUPLICATE_LOCALE',
        value: locale,
        message: `locale "${locale}" is declared more than once`,
      });
      continue;
    }
    seen.add(locale);
  }

  if (locales.length > 0 && !locales.includes(input.defaultLocale)) {
    issues.push({
      code: 'DEFAULT_LOCALE_NOT_ENABLED',
      value: input.defaultLocale,
      message: `defaultLocale "${input.defaultLocale}" must be one of the enabled locales`,
    });
  }

  if (!isValidTimezone(input.timezone)) {
    issues.push({
      code: 'INVALID_TIMEZONE',
      value: input.timezone,
      message: `timezone "${input.timezone}" is not a recognized IANA time zone`,
    });
  }

  if (issues.length > 0) {
    throw new ContentConfigError(issues);
  }

  return Object.freeze({
    locales: Object.freeze([...locales]),
    defaultLocale: input.defaultLocale,
    timezone: input.timezone,
  });
}

/** Emitted when an already-applied seed item (a content type or field) no
 * longer matches its seed definition (D-04). Never overwritten silently --
 * this is a notice only. */
export type SeedDriftEvent = {
  readonly seedId: string;
  readonly kind: 'type' | 'field';
  readonly property: string;
  readonly seededValue: unknown;
  readonly storedValue: unknown;
  readonly occurredAt: Date;
};

/** Emitted at boot when a locale present in stored content is no longer in
 * `ContentConfig.locales` (D-25). Those rows are kept, excluded from reads,
 * and restored if the locale is added back. */
export type LocaleRemovedEvent = {
  readonly locale: string;
  readonly entryCount: number;
  readonly occurredAt: Date;
};

export type ContentHooks = {
  readonly onSeedDrift?: (event: SeedDriftEvent) => void;
  readonly onLocaleRemoved?: (event: LocaleRemovedEvent) => void;
};

/** Every engine operation's dependency bag: the database handle, the
 * audited-mutation recorder, the permission resolver, the validated content
 * config, optional warning hooks, and an injectable clock (defaults to
 * `() => new Date()`). */
export type ContentDeps = {
  readonly db: AuditDatabase;
  readonly recorder: AuditRecorder;
  readonly resolver: PermissionResolver;
  readonly config: ContentConfig;
  readonly hooks?: ContentHooks;
  readonly now?: () => Date;
};

/**
 * Invokes a warning hook (or its fallback) inside a try/catch, handling a
 * hook that returns a rejected promise the same way
 * `reportAuditWriteFailure` does in `@plakboek/auth` -- a broken or slow
 * host-supplied hook can never crash the operation it is reporting on.
 */
export function reportContentWarning<E>(
  hook: ((event: E) => void) | undefined,
  fallback: (event: E) => void,
  event: E,
): void {
  const invoke = hook ?? fallback;
  try {
    const returned: unknown = invoke(event);
    if (
      typeof returned === 'object' &&
      returned !== null &&
      typeof Reflect.get(returned, 'then') === 'function'
    ) {
      void Promise.resolve(returned).catch((hookError: unknown) => {
        logHookFailure(hookError);
      });
    }
  } catch (hookError) {
    logHookFailure(hookError);
  }
}

function logHookFailure(hookError: unknown): void {
  try {
    // oxlint-disable-next-line no-console -- last-resort fallback when a host-supplied content warning hook itself throws or rejects
    console.error('[@plakboek/content] a warning hook threw', hookError);
  } catch {
    // Never let a broken console/logger escape either.
  }
}
