import { describe, expect, it, vi } from 'vitest';
import {
  CMS_ROBOTS_TAG,
  cmsGuard,
  withCmsHeaders,
} from '../../src/cms-headers.js';

describe('withCmsHeaders', () => {
  it('sets X-Robots-Tag to noindex, nofollow and keeps every other header', async () => {
    const original = new Response('body', {
      status: 201,
      statusText: 'Created',
      headers: { 'Cache-Control': 'no-store', 'X-Other': 'kept' },
    });
    const wrapped = withCmsHeaders(original);
    expect(wrapped.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(wrapped.headers.get('Cache-Control')).toBe('no-store');
    expect(wrapped.headers.get('X-Other')).toBe('kept');
    expect(wrapped.status).toBe(201);
    expect(wrapped.statusText).toBe('Created');
    expect(await wrapped.text()).toBe('body');
  });

  it('replaces a different X-Robots-Tag rather than adding a second', () => {
    const wrapped = withCmsHeaders(
      new Response(null, { headers: { 'X-Robots-Tag': 'all' } }),
    );
    expect(wrapped.headers.get('X-Robots-Tag')).toBe(CMS_ROBOTS_TAG);
    expect(
      [...wrapped.headers].filter(([name]) => name === 'x-robots-tag'),
    ).toHaveLength(1);
  });

  it('works on a response whose headers are immutable', () => {
    const redirect = Response.redirect('http://localhost/about', 302);
    const wrapped = withCmsHeaders(redirect);
    expect(wrapped.status).toBe(302);
    expect(wrapped.headers.get('Location')).toBe('http://localhost/about');
    expect(wrapped.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('keeps a bodiless status bodiless', () => {
    const wrapped = withCmsHeaders(new Response(null, { status: 204 }));
    expect(wrapped.status).toBe(204);
    expect(wrapped.body).toBeNull();
  });
});

describe('cmsGuard', () => {
  it('sets the header on what the handler answers, sync or async', async () => {
    const sync = await cmsGuard(() => new Response('a', { status: 202 }));
    expect(sync.status).toBe(202);
    expect(sync.headers.get('X-Robots-Tag')).toBe(CMS_ROBOTS_TAG);
    const async = await cmsGuard(() => Promise.resolve(new Response('b')));
    expect(async.headers.get('X-Robots-Tag')).toBe(CMS_ROBOTS_TAG);
    expect(await async.text()).toBe('b');
  });

  it('answers a throw with a headered 500 that holds no message, and logs only the error name', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const response = await cmsGuard(() => {
        throw new TypeError('postgres://user:secret@db/plakboek is down');
      });
      expect(response.status).toBe(500);
      expect(response.headers.get('X-Robots-Tag')).toBe(CMS_ROBOTS_TAG);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.text()).toBe('Internal Server Error');
      const logged = write.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(logged).toContain('TypeError');
      expect(logged).not.toContain('secret');
    } finally {
      write.mockRestore();
    }
  });

  it('answers a rejected promise the same way', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const response = await cmsGuard(() => Promise.reject(new Error('x')));
      expect(response.status).toBe(500);
      expect(response.headers.get('X-Robots-Tag')).toBe(CMS_ROBOTS_TAG);
    } finally {
      write.mockRestore();
    }
  });
});
