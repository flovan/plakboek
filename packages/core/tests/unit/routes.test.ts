import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmsRoutes } from '../../dist/routes.js';

describe('cmsRoutes', () => {
  const routes = cmsRoutes();

  it('lists the CMS routes before the visitor entries, in order', () => {
    expect(routes.map((entry) => entry.id)).toEqual([
      'plakboek-health',
      'plakboek-setup',
      'plakboek-setup-test-email',
      'plakboek-auth',
      'plakboek-visitor-index',
      'plakboek-visitor',
    ]);
    expect(routes[0]?.path).toBe('cms/health');
    expect(routes[1]?.path).toBe('cms/setup');
    expect(routes[2]?.path).toBe('cms/setup/test-email');
    expect(routes[3]?.path).toBe('api/auth/*');
  });

  it('returns an index entry and a splat entry with distinct explicit ids', () => {
    const indexEntry = routes.find((entry) => entry.index === true);
    const splat = routes.find((entry) => entry.path === '*');
    expect(indexEntry?.id).toBe('plakboek-visitor-index');
    expect(splat?.id).toBe('plakboek-visitor');
    expect(new Set(routes.map((entry) => entry.id)).size).toBe(routes.length);
  });

  it('points every entry at an absolute file that exists on disk', () => {
    expect(routes.length).toBeGreaterThan(0);
    for (const entry of routes) {
      expect(isAbsolute(entry.file)).toBe(true);
      expect(existsSync(entry.file)).toBe(true);
    }
  });
});
