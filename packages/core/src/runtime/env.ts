/**
 * The validated process environment. Stub: the real parser lands with the
 * GREEN commit.
 */
import type { SmtpOptions } from '@plakboek/auth';

export const SECRET_GENERATION_COMMAND = '';

export type RuntimeEnv = {
  readonly databaseUrl: string;
  readonly migrationDatabaseUrl?: string;
  readonly siteUrl: string;
  readonly secret: string;
  readonly buildId?: string;
  readonly smtp?: SmtpOptions;
  readonly mailFrom?: string;
  readonly production: boolean;
};

export type EnvIssue = { readonly variable: string; readonly message: string };

export class PlakboekEnvError extends Error {
  readonly issues: readonly EnvIssue[] = [];
}

export function readRuntimeEnv(
  _source: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeEnv {
  throw new Error('not implemented');
}
