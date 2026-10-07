import { describe, expect, it } from 'vitest';
import { injectDevClient } from '../../src/dev-client.js';

const TAG = '<script type="module" src="/@vite/client"></script>';

function html(init: ResponseInit = {}): Response {
  return new Response(
    '<html><head><title>x</title></head><body>hi</body></html>',
    {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        ETag: '"abc"',
        'Content-Length': '60',
        'X-Probe': 'kept',
      },
      ...init,
    },
  );
}

describe('injectDevClient', () => {
  it('inserts the Vite client immediately before </head>', async () => {
    const result = await injectDevClient(html());
    expect(await result.text()).toBe(
      `<html><head><title>x</title>${TAG}</head><body>hi</body></html>`,
    );
  });

  it('drops ETag and Content-Length and keeps status and other headers', async () => {
    const result = await injectDevClient(html());
    expect(result.status).toBe(200);
    expect(result.headers.get('ETag')).toBeNull();
    expect(result.headers.get('Content-Length')).toBeNull();
    expect(result.headers.get('X-Probe')).toBe('kept');
    expect(result.headers.get('Content-Type')).toContain('text/html');
  });

  it('returns a non-HTML response unchanged', async () => {
    const original = new Response('{"a":1}', {
      headers: { 'Content-Type': 'application/json' },
    });
    const result = await injectDevClient(original);
    expect(result).toBe(original);
  });

  it('returns a non-200 HTML response unchanged', async () => {
    const original = html({ status: 404 });
    expect(await injectDevClient(original)).toBe(original);
  });

  it('returns HTML without a head untouched', async () => {
    const original = new Response('<p>fragment</p>', {
      headers: { 'Content-Type': 'text/html' },
    });
    const result = await injectDevClient(original);
    expect(await result.text()).toBe('<p>fragment</p>');
  });
});
