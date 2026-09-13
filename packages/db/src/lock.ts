import type { Client } from "pg";

/**
 * Fixed advisory-lock key reserved for @plakboek/db's migration runner.
 * Postgres advisory locks share a single namespace per database across every
 * caller -- this key must never be reused by another subsystem within a
 * @plakboek/db-managed database.
 */
export const MIGRATION_LOCK_KEY = "4839120657231098713";

export class MigrationLockTimeoutError extends Error {
	readonly waitedMs: number;

	constructor(waitedMs: number) {
		super(`@plakboek/db: another migrator still holds the migration lock after ${waitedMs}ms`);
		this.name = "MigrationLockTimeoutError";
		this.waitedMs = waitedMs;
	}
}

export interface LockOptions {
	readonly waitMs?: number;
	readonly pollIntervalMs?: number;
}

/**
 * RED-phase stub (#3990/tdd.md): the final type shape (MIGRATION_LOCK_KEY,
 * MigrationLockTimeoutError, LockOptions) is already correct so
 * tests/integration/lock.test.ts resolves and fails on its own assertions,
 * not on a module-load error. The locking logic itself is implemented in the
 * GREEN phase.
 */
export async function withMigrationLock<T>(
	_client: Client,
	_fn: () => Promise<T>,
	_options?: LockOptions,
): Promise<T> {
	throw new Error("@plakboek/db: withMigrationLock is not implemented yet");
}
