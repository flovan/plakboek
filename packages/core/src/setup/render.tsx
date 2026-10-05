import type { BootstrapField } from '../runtime/bootstrap.js';

export type SetupIssue = {
  readonly field: BootstrapField;
  readonly message: string;
};

export type SetupValues = { readonly name?: string; readonly email?: string };

export type TestEmailResult =
  | { readonly kind: 'sent' }
  | { readonly kind: 'console' }
  | { readonly kind: 'unconfigured' }
  | { readonly kind: 'failed'; readonly detail: string };

export function renderSetupForm(_options: {
  readonly values?: SetupValues;
  readonly issues?: readonly SetupIssue[];
}): string {
  return '';
}

export function renderSetupUnavailable(_kind: 'race' | 'database'): string {
  return '';
}

export function renderSetupComplete(_options: {
  readonly email: string;
  readonly token: string;
  readonly homePublished: boolean;
  readonly result?: TestEmailResult;
}): string {
  return '';
}
