/**
 * The site context through a real fixture build: the async menu helper marks
 * the current item, and an unknown path is the host's own sealed 404.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_CLIENT_DIR, FIXTURE_SERVER_ENTRY } from './fixture-host.js';
import { createInstallation, type Installation } from './installation.js';

describe('the host site module', () => {
  let installation: Installation;
  let url: (path: string) => string;

  beforeAll(async () => {
    installation = await createInstallation();
    ({ url } = await installation.serve({
      serverEntry: FIXTURE_SERVER_ENTRY,
      clientDir: FIXTURE_CLIENT_DIR,
    }));
  });

  afterAll(async () => {
    await installation?.dispose();
  });

  it('renders the main menu with aria-current on the current item', async () => {
    const response = await fetch(url('/'));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('<nav aria-label="Main">');
    expect(body).toContain('<a href="/" aria-current="page">Home</a>');
    expect(body).toContain('<a href="/">Fixture site</a>');
    expect(body).toContain('Hello world');
  });

  it('serves the host not-found page as an uncacheable 404', async () => {
    const response = await fetch(url('/nope'));
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toContain('text/html');
    const body = await response.text();
    expect(body).toContain('Page not found');
    expect(body).toContain('<nav aria-label="Main">');
    expect(body).not.toContain('aria-current');
  });

  it('renders the 404 of a localised path in that locale', async () => {
    const response = await fetch(url('/nl/onbekend'));
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('<html lang="nl">');
  });
});
