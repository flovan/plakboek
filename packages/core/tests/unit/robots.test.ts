import { describe, expect, it } from 'vitest';
import { loader } from '../../src/route-modules/robots.js';

describe('the default robots.txt', () => {
  it('tells every crawler to stay out of /cms, as plain text a shared cache may keep for an hour', async () => {
    const response = loader();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe(
      'text/plain; charset=utf-8',
    );
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(await response.text()).toBe('User-agent: *\nDisallow: /cms\n');
  });
});
