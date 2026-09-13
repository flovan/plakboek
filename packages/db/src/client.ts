import type { Sql } from "postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export interface CreateDbOptions {
	readonly connectionString: string;
	readonly maxConnections?: number;
}

export interface Db {
	readonly db: PostgresJsDatabase;
	readonly sql: Sql;
	close(): Promise<void>;
}

export class DbConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DbConfigError";
	}
}

/**
 * RED-phase stub (#3990/tdd.md): the final type shape (CreateDbOptions, Db,
 * DbConfigError) is already correct so tests/unit/client.test.ts resolves and
 * fails on its own assertions, not on a module-load error. The connection
 * factory itself is implemented in the GREEN phase.
 */
export function createDb(_options: CreateDbOptions): Db {
	throw new Error("@plakboek/db: createDb is not implemented yet");
}
