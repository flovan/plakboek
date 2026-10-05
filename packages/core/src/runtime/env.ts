/**
 * The validated process environment (D-01, D-28). One function reads every
 * variable the runtime needs, collects every problem, and throws once, so an
 * operator fixes a whole `.env` in one pass. Messages name variables and
 * rules, never values: a connection string, a secret or an SMTP password
 * cannot reach a log through here.
 *
 * Variables:
 *
 * - `DATABASE_URL` (required) postgres(ql) connection string.
 * - `DATABASE_MIGRATION_URL` (optional) direct connection for migrations,
 *   used by the CLI.
 * - `PLAKBOEK_URL` (required) the installation's public origin. Never derived
 *   from a request (a Host header is attacker-controlled).
 * - `PLAKBOEK_SECRET` (required) at least 32 characters, no fallback in any
 *   NODE_ENV.
 * - `PLAKBOEK_BUILD_ID` (optional) identifies the deployed render code.
 * - `PLAKBOEK_SMTP_HOST/PORT/SECURE/USER/PASS` and `PLAKBOEK_MAIL_FROM`
 *   (optional) the mail transport; read only when the host is non-blank.
 */
import type { SmtpOptions } from '@plakboek/auth';

/** The shortest secret the auth layer accepts. */
const MIN_SECRET_LENGTH = 32;

/** Prints 32 random bytes, base64url encoded. Shown in the secret's error. */
export const SECRET_GENERATION_COMMAND = `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`;

const BUILD_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const POSTGRES_URL_PATTERN = /^postgres(ql)?:\/\//i;
const MAX_PORT = 65_535;

/** What the runtime reads from the environment, validated. */
export type RuntimeEnv = {
  readonly databaseUrl: string;
  readonly migrationDatabaseUrl?: string;
  /** The public origin, without a trailing slash. */
  readonly siteUrl: string;
  readonly secret: string;
  readonly buildId?: string;
  readonly smtp?: SmtpOptions;
  readonly mailFrom?: string;
  /** `NODE_ENV === 'production'`. */
  readonly production: boolean;
};

export type EnvIssue = {
  readonly variable: string;
  readonly message: string;
};

/** Every invalid variable, collected. Never carries a value. */
export class PlakboekEnvError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    super(
      [
        '[@plakboek/core] invalid environment:',
        ...issues.map((issue) => `- ${issue.message}`),
      ].join('\n'),
    );
    this.name = 'PlakboekEnvError';
    this.issues = issues;
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;

function present(source: EnvSource, name: string): string | undefined {
  const value = source[name];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function readPostgresUrl(
  source: EnvSource,
  name: string,
  required: boolean,
  issues: EnvIssue[],
): string | undefined {
  const value = present(source, name);
  if (value === undefined) {
    if (required) {
      issues.push({
        variable: name,
        message: `${name} is not set: expected a postgres:// or postgresql:// connection string`,
      });
    }
    return undefined;
  }
  if (!POSTGRES_URL_PATTERN.test(value)) {
    issues.push({
      variable: name,
      message: `${name} must be a postgres:// or postgresql:// connection string`,
    });
    return undefined;
  }
  return value;
}

/** A bare http(s) origin: no path, query, fragment or credentials. */
function readSiteUrl(
  source: EnvSource,
  issues: EnvIssue[],
): string | undefined {
  const value = present(source, 'PLAKBOEK_URL');
  if (value === undefined) {
    issues.push({
      variable: 'PLAKBOEK_URL',
      message:
        'PLAKBOEK_URL is not set: expected the installation origin, such as https://www.example.org',
    });
    return undefined;
  }
  const rule =
    'PLAKBOEK_URL must be an absolute http:// or https:// origin without a path, query or fragment, such as https://www.example.org';
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    issues.push({ variable: 'PLAKBOEK_URL', message: rule });
    return undefined;
  }
  const raw = value.trim();
  const acceptable =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.pathname === '/' &&
    url.username === '' &&
    url.password === '' &&
    !raw.includes('?') &&
    !raw.includes('#');
  if (!acceptable) {
    issues.push({ variable: 'PLAKBOEK_URL', message: rule });
    return undefined;
  }
  return url.origin;
}

function readSecret(source: EnvSource, issues: EnvIssue[]): string | undefined {
  const value = source.PLAKBOEK_SECRET;
  if (value === undefined || value.length < MIN_SECRET_LENGTH) {
    issues.push({
      variable: 'PLAKBOEK_SECRET',
      message: `PLAKBOEK_SECRET is not set (or shorter than ${MIN_SECRET_LENGTH} characters). Generate one with: ${SECRET_GENERATION_COMMAND} and set PLAKBOEK_SECRET to its output in .env`,
    });
    return undefined;
  }
  return value;
}

function readSmtp(
  source: EnvSource,
  issues: EnvIssue[],
): SmtpOptions | undefined {
  const host = present(source, 'PLAKBOEK_SMTP_HOST');
  if (host === undefined) return undefined;

  let port: number | undefined;
  const rawPort = present(source, 'PLAKBOEK_SMTP_PORT');
  if (rawPort !== undefined) {
    const parsed = /^\d+$/.test(rawPort.trim()) ? Number(rawPort.trim()) : NaN;
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_PORT) {
      port = parsed;
    } else {
      issues.push({
        variable: 'PLAKBOEK_SMTP_PORT',
        message: `PLAKBOEK_SMTP_PORT must be an integer between 1 and ${MAX_PORT}`,
      });
    }
  }

  let secure: boolean | undefined;
  const rawSecure = present(source, 'PLAKBOEK_SMTP_SECURE');
  if (rawSecure !== undefined) {
    const normalised = rawSecure.trim().toLowerCase();
    if (normalised === 'true') secure = true;
    else if (normalised === 'false') secure = false;
    else {
      issues.push({
        variable: 'PLAKBOEK_SMTP_SECURE',
        message:
          'PLAKBOEK_SMTP_SECURE must be true (implicit TLS, port 465) or false',
      });
    }
  }

  const user = present(source, 'PLAKBOEK_SMTP_USER');
  const pass = present(source, 'PLAKBOEK_SMTP_PASS');
  if (user !== undefined && pass === undefined) {
    issues.push({
      variable: 'PLAKBOEK_SMTP_PASS',
      message:
        'PLAKBOEK_SMTP_PASS must be set together with PLAKBOEK_SMTP_USER',
    });
  } else if (pass !== undefined && user === undefined) {
    issues.push({
      variable: 'PLAKBOEK_SMTP_USER',
      message:
        'PLAKBOEK_SMTP_USER must be set together with PLAKBOEK_SMTP_PASS',
    });
  }

  return {
    host: host.trim(),
    ...(port === undefined ? {} : { port }),
    ...(secure === undefined ? {} : { secure }),
    ...(user !== undefined && pass !== undefined ? { user, pass } : {}),
  };
}

/** Reads and validates the runtime environment; throws `PlakboekEnvError`. */
export function readRuntimeEnv(source: EnvSource = process.env): RuntimeEnv {
  const issues: EnvIssue[] = [];

  const databaseUrl = readPostgresUrl(source, 'DATABASE_URL', true, issues);
  const migrationDatabaseUrl = readPostgresUrl(
    source,
    'DATABASE_MIGRATION_URL',
    false,
    issues,
  );
  const siteUrl = readSiteUrl(source, issues);
  const secret = readSecret(source, issues);

  let buildId: string | undefined;
  const rawBuildId = present(source, 'PLAKBOEK_BUILD_ID');
  if (rawBuildId !== undefined) {
    if (BUILD_ID_PATTERN.test(rawBuildId)) buildId = rawBuildId;
    else {
      issues.push({
        variable: 'PLAKBOEK_BUILD_ID',
        message: `PLAKBOEK_BUILD_ID must match ${BUILD_ID_PATTERN.source}`,
      });
    }
  }

  const smtp = readSmtp(source, issues);
  const mailFrom = present(source, 'PLAKBOEK_MAIL_FROM')?.trim();

  if (
    issues.length > 0 ||
    databaseUrl === undefined ||
    siteUrl === undefined ||
    secret === undefined
  ) {
    throw new PlakboekEnvError(issues);
  }

  return {
    databaseUrl,
    ...(migrationDatabaseUrl === undefined ? {} : { migrationDatabaseUrl }),
    siteUrl,
    secret,
    ...(buildId === undefined ? {} : { buildId }),
    ...(smtp === undefined ? {} : { smtp }),
    ...(mailFrom === undefined ? {} : { mailFrom }),
    production: source.NODE_ENV === 'production',
  };
}
