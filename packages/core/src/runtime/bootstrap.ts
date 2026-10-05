/**
 * First-run bootstrap. Stub: the real implementation lands with the GREEN
 * commit.
 */
import type { Runtime } from './runtime.js';

export type BootstrapInput = {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly passwordConfirm?: string;
};

export type BootstrapField = 'name' | 'email' | 'password' | 'passwordConfirm';

export type BootstrapIssue = {
  readonly field: BootstrapField;
  readonly message: string;
};

export type BootstrapResult = {
  readonly userId: string;
  readonly email: string;
  readonly homePublished: boolean;
  readonly homePath: '/';
};

export class BootstrapValidationError extends Error {
  readonly issues: readonly BootstrapIssue[] = [];
}

export class InstallationNotEmptyError extends Error {}

export class DatabaseNotReadyError extends Error {}

export function validateBootstrapInput(
  _input: BootstrapInput,
): readonly BootstrapIssue[] {
  return [];
}

export function bootstrapInstallation(
  _runtime: Runtime,
  _input: BootstrapInput,
): Promise<BootstrapResult> {
  return Promise.reject(new Error('not implemented'));
}
