/** Paths and shared constants for the built e2e host. */
import { join, resolve } from 'node:path';

const PACKAGE_DIR = resolve(import.meta.dirname, '..', '..', '..');

export const E2E_HOST_DIR = join(PACKAGE_DIR, 'tests', 'e2e-host');
export const E2E_BUILD_DIR = join(E2E_HOST_DIR, 'build');
export const E2E_SERVER_ENTRY = join(E2E_BUILD_DIR, 'server', 'index.js');
export const E2E_CLIENT_DIR = join(E2E_BUILD_DIR, 'client');

export type E2eAccount = {
  readonly email: string;
  readonly password: string;
};

export type E2eUsers = {
  readonly superadmin: E2eAccount;
  readonly editor: E2eAccount;
  readonly viewer: E2eAccount;
};

/** The accounts global setup created, read from the worker's environment. */
export function e2eUsers(): E2eUsers {
  const raw = process.env.E2E_USERS;
  if (raw === undefined || raw.length === 0) {
    throw new Error('E2E_USERS is not set: the e2e global setup did not run');
  }
  return JSON.parse(raw) as E2eUsers;
}
