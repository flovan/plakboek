import { Client } from 'pg';

/**
 * Vitest globalSetup for the real-Postgres integration suite. Fails loudly
 * and immediately when TEST_DATABASE_URL is missing, rather than letting
 * individual tests time out one by one against nothing. Any connection error
 * is reported by host/port only (parsed via `new URL()`) -- the raw
 * connection string, and any password it may contain, is never included in
 * the thrown message (T-01-09).
 */
export default async function setup(): Promise<void> {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString || connectionString.length === 0) {
    throw new Error(
      'TEST_DATABASE_URL is not set: run `docker compose up -d --wait postgres` and export the value from .env.example',
    );
  }

  const { hostname, port, password } = new URL(connectionString);
  const client = new Client({ connectionString });

  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const redactedReason = password
      ? reason.split(password).join('<redacted>')
      : reason;
    throw new Error(
      `Could not reach Postgres at ${hostname}:${port || '5432'} using TEST_DATABASE_URL -- run \`docker compose up -d --wait postgres\` first (${redactedReason})`,
      { cause: error },
    );
  } finally {
    await client.end();
  }
}
