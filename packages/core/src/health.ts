/** The slice of the database handle the health probe needs. */
export type HealthDb = {
  readonly sql: (strings: TemplateStringsArray) => PromiseLike<unknown>;
};

export function healthResponse(_db: HealthDb): Promise<Response> {
  return Promise.resolve(new Response(null, { status: 500 }));
}
