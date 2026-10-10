import { describe, expect, it } from 'vitest';
import { CMS_ROBOTS_TAG, withCmsHeaders } from '../../src/cms-headers.js';

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
