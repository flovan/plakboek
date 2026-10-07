/**
 * The production server's cap on the first-run setup paths: an oversized body
 * is refused with 413 before the request handler runs, whether its size is
 * declared or only shows up while a chunked body streams, and whatever the
 * letter case of the path (React Router routes case-insensitively).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server.js';

// The contract value, pinned independently of the implementation constant.
const CAP = 16 * 1024;

type Downstream = { reached: number; bytes: number };

describe('the production server setup body cap', () => {
  let clientDir: string;

  beforeAll(async () => {
    clientDir = await mkdtemp(join(tmpdir(), 'plakboek-body-limit-'));
  });

  afterAll(async () => {
    await rm(clientDir, { recursive: true, force: true });
  });

  /** An app whose catch-all stands in for React Router and counts what arrives. */
  function appWithDownstream(): {
    request: (path: string, init: RequestInit) => Promise<Response>;
    downstream: Downstream;
  } {
    const { app } = createServer({ clientDir });
    const downstream: Downstream = { reached: 0, bytes: 0 };
    app.post('*', async (context) => {
      downstream.reached += 1;
      downstream.bytes = (await context.req.raw.arrayBuffer()).byteLength;
      return context.text('ok');
    });
    return {
      request: async (path, init) => await app.request(path, init),
      downstream,
    };
  }

  function declared(size: number): RequestInit {
    return {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': String(size),
      },
      body: 'x'.repeat(size),
    };
  }

  function chunked(size: number, chunkSize = 4096): RequestInit {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= size) {
          controller.close();
          return;
        }
        const length = Math.min(chunkSize, size - sent);
        controller.enqueue(new Uint8Array(length).fill(120));
        sent += length;
      },
    });
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      duplex: 'half',
    } as RequestInit;
  }

  it('answers 413 to a declared body over the cap without reaching the handler', async () => {
    const { request, downstream } = appWithDownstream();
    const response = await request('/cms/setup', declared(CAP + 1));
    expect(response.status).toBe(413);
    expect(downstream.reached).toBe(0);
  });

  it('answers 413 to a chunked body over the cap on the test-email path', async () => {
    const { request, downstream } = appWithDownstream();
    const response = await request('/cms/setup/test-email', chunked(32 * 1024));
    expect(response.status).toBe(413);
    expect(downstream.reached).toBe(0);
  });

  it('answers 413 whatever the letter case of the path', async () => {
    const { request, downstream } = appWithDownstream();
    const response = await request('/CMS/Setup', declared(32 * 1024));
    expect(response.status).toBe(413);
    const upper = await request('/CMS/SETUP/TEST-EMAIL', chunked(32 * 1024));
    expect(upper.status).toBe(413);
    expect(downstream.reached).toBe(0);
  });

  it('lets a body of exactly the cap through', async () => {
    const { request, downstream } = appWithDownstream();
    const response = await request('/cms/setup', declared(CAP));
    expect(response.status).toBe(200);
    expect(downstream.reached).toBe(1);
    expect(downstream.bytes).toBe(CAP);
  });

  it('hands a small chunked body downstream with its bytes intact', async () => {
    const { request, downstream } = appWithDownstream();
    const response = await request('/cms/setup/test-email', chunked(3000, 700));
    expect(response.status).toBe(200);
    expect(downstream.reached).toBe(1);
    expect(downstream.bytes).toBe(3000);
  });

  it('leaves every other path alone', async () => {
    const { request, downstream } = appWithDownstream();
    const response = await request('/contact', declared(32 * 1024));
    expect(response.status).toBe(200);
    expect(downstream.reached).toBe(1);
    expect(downstream.bytes).toBe(32 * 1024);
  });

  it('answers with a fixed uncacheable text body', async () => {
    const { request } = appWithDownstream();
    const response = await request('/cms/setup', declared(CAP + 1));
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(response.headers.get('Content-Type')).toContain('text/plain');
    expect(await response.text()).toBe('Payload Too Large');
  });
});
