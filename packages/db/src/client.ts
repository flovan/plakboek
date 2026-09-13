import postgres, { type Sql } from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';

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
    this.name = 'DbConfigError';
  }
}

const DEFAULT_MAX_CONNECTIONS = 10;
const CLOSE_TIMEOUT_SECONDS = 5;
const POSTGRES_SCHEMES = ['postgres://', 'postgresql://'];

/**
 * Validates the connection string's shape only (scheme prefix). The message
 * never echoes the supplied value (T-01-09) -- it always names the two
 * expected schemes instead.
 */
function assertPostgresConnectionString(connectionString: string): void {
  const isNonEmptyString =
    typeof connectionString === 'string' && connectionString.length > 0;
  const hasPostgresScheme =
    isNonEmptyString &&
    POSTGRES_SCHEMES.some((scheme) => connectionString.startsWith(scheme));

  if (!hasPostgresScheme) {
    throw new DbConfigError(
      '@plakboek/db: connectionString must be a non-empty string starting with "postgres://" or "postgresql://"',
    );
  }
}

export function createDb(options: CreateDbOptions): Db {
  assertPostgresConnectionString(options.connectionString);

  const max = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const sql = postgres(options.connectionString, { max });
  const db = drizzle({ client: sql });

  return {
    db,
    sql,
    async close(): Promise<void> {
      await sql.end({ timeout: CLOSE_TIMEOUT_SECONDS });
    },
  };
}
