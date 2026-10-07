/**
 * The liveness-and-database probe behind `GET /cms/health`. The bodies are
 * fixed strings: a database error, which can carry a host name or a user
 * name, never reaches the response, and nothing here touches mail or auth.
 */

/** The slice of the database handle the health probe needs. */
export type HealthDb = {
  readonly sql: (strings: TemplateStringsArray) => PromiseLike<unknown>;
};

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
} as const;

/** 200 when the database answers `SELECT 1`, 503 otherwise. */
export async function healthResponse(db: HealthDb): Promise<Response> {
  try {
    await db.sql`SELECT 1`;
    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: HEADERS,
    });
  } catch {
    return new Response(JSON.stringify({ status: 'unavailable' }), {
      status: 503,
      headers: HEADERS,
    });
  }
}
