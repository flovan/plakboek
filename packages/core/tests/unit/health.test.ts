import { describe, expect, it } from 'vitest';
import { healthResponse, type HealthDb } from '../../src/health.js';

const answering: HealthDb = { sql: () => Promise.resolve([{ '?column?': 1 }]) };

function failing(message: string): HealthDb {
  return {
    sql: () => Promise.reject(new Error(message)),
  };
}

describe('healthResponse', () => {
  it('answers 200 ok when the database answers', async () => {
    const response = await healthResponse(answering);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('answers 503 unavailable when the query rejects', async () => {
    const response = await healthResponse(failing('connect ECONNREFUSED'));
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'unavailable' });
  });

  it('never puts the database error text in the response', async () => {
    const secret = 'password authentication failed for user "s3cret-user"';
    const response = await healthResponse(failing(secret));
    const body = await response.text();
    expect(body).not.toContain('s3cret-user');
    expect(body).not.toContain('password');
    for (const [name, value] of response.headers) {
      expect(`${name}: ${value}`).not.toContain('s3cret-user');
    }
  });

  it('answers 503 when the query throws synchronously', async () => {
    const response = await healthResponse({
      sql: () => {
        throw new Error('sync failure');
      },
    });
    expect(response.status).toBe(503);
  });
});
