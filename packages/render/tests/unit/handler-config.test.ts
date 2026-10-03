/**
 * Handler creation refuses an invalid `cacheControl` or `buildId` before any
 * database use: both end up in response headers and cache entries, so a CR/LF
 * or an unbounded value must never get past creation. Every issue is
 * collected into the one `VisitorHandlerConfigError`.
 */
import type { PagesConfig, PagesDeps } from '@plakboek/pages';
import { describe, expect, it } from 'vitest';
import {
  createVisitorHandler,
  VisitorHandlerConfigError,
  type VisitorHandlerDeps,
} from '../../src/server.js';

const CONFIG: PagesConfig = {
  content: {
    locales: ['en'],
    defaultLocale: 'en',
    timezone: 'Europe/Brussels',
  },
  blocks: [],
  sectionNestingDepth: 2,
  blockDepthCeiling: 12,
};

const THROWING_DB = new Proxy(
  {},
  {
    get(): never {
      throw new Error('the database must not be touched');
    },
  },
) as PagesDeps['db'];

function issuesOf(
  extra: Partial<VisitorHandlerDeps>,
): VisitorHandlerConfigError['issues'] {
  try {
    createVisitorHandler({ db: THROWING_DB, config: CONFIG, ...extra });
  } catch (error) {
    if (error instanceof VisitorHandlerConfigError) return error.issues;
    throw error;
  }
  return [];
}

describe('cacheControl validation', () => {
  it.each([
    ['a header-injection attempt', 'public, max-age=60\r\nX-Evil: 1'],
    ['a bare line feed', 'public\nX-Evil: 1'],
    ['an empty string', ''],
    ['a 300-character value', `public, ${'x'.repeat(292)}`],
    ['a non-ASCII value', 'public, max-age=60, ünïcode'],
  ])('refuses %s', (_label, cacheControl) => {
    expect(issuesOf({ cacheControl }).map((issue) => issue.code)).toEqual([
      'invalid-cache-control',
    ]);
  });

  it('accepts a shared-cache directive list', () => {
    expect(
      issuesOf({ cacheControl: 'public, max-age=60, s-maxage=86400' }),
    ).toEqual([]);
  });
});

describe('buildId validation', () => {
  it.each([
    ['a space', 'a b'],
    ['a 200-character value', 'a'.repeat(200)],
    ['an empty string', ''],
    ['a line break', 'abc\r\nX-Evil: 1'],
  ])('refuses %s', (_label, buildId) => {
    expect(issuesOf({ buildId }).map((issue) => issue.code)).toEqual([
      'invalid-build-id',
    ]);
  });

  it('accepts a version-and-hash identifier', () => {
    expect(issuesOf({ buildId: '2026.10.02-abc_1' })).toEqual([]);
  });
});

describe('collected config issues', () => {
  it('lists every invalid value in one error', () => {
    const issues = issuesOf({
      cacheControl: 'public, max-age=60\r\nX-Evil: 1',
      buildId: 'a b',
      siteUrl: 'not a url',
    });
    expect(issues.map((issue) => issue.code).toSorted()).toEqual([
      'INVALID_SITE_URL',
      'invalid-build-id',
      'invalid-cache-control',
    ]);
  });
});
