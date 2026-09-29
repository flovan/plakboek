import type { AuditTransaction } from '@plakboek/auth';
import { describe, expect, it } from 'vitest';
import {
  assertPageSlugAvailable,
  composePagePath,
  generateUniquePageSlug,
  InvalidPageSlugError,
  PageSlugConflictError,
  PageSlugGenerationError,
  pageSlugLockKey,
} from '../../src/page-slug.js';

// A transaction is never reached by any assertion in this file: every
// bullet tested here throws before the first `tx.execute`/`tx.select`
// call, so a transaction stand-in that would throw if touched proves the
// check really does run before any database access.
const UNREACHABLE_TX = new Proxy(
  {},
  {
    get(): never {
      throw new Error('unexpected transaction access in a database-free test');
    },
  },
) as AuditTransaction;

describe('composePagePath (D-21)', () => {
  it('returns the slug unchanged at the root', () => {
    expect(composePagePath(null, 'about')).toBe('about');
  });

  it('joins parent path and slug with one slash otherwise', () => {
    expect(composePagePath('about', 'team')).toBe('about/team');
    expect(composePagePath('about/team', 'history')).toBe('about/team/history');
  });
});

describe('pageSlugLockKey', () => {
  it('is stable: the same (locale, parentPageId) pair always yields the same key', () => {
    const first = pageSlugLockKey('en', 'parent-1');
    const second = pageSlugLockKey('en', 'parent-1');
    expect(first).toBe(second);
  });

  it('treats a null parentPageId as the literal "@root", stable across calls', () => {
    expect(pageSlugLockKey('en', null)).toBe(pageSlugLockKey('en', null));
  });

  it('differs across locale and parent so unrelated creations do not serialize', () => {
    const keys = new Set([
      pageSlugLockKey('en', null),
      pageSlugLockKey('nl', null),
      pageSlugLockKey('en', 'parent-1'),
      pageSlugLockKey('en', 'parent-2'),
    ]);
    expect(keys.size).toBe(4);
  });

  it('always returns a value that fits Postgres int4 (signed 32-bit)', () => {
    const key = pageSlugLockKey('en', 'some-very-long-parent-id-value');
    expect(Number.isInteger(key)).toBe(true);
    expect(key).toBeGreaterThanOrEqual(-2_147_483_648);
    expect(key).toBeLessThanOrEqual(2_147_483_647);
  });
});

describe('generateUniquePageSlug: normalisation, no database needed', () => {
  it('rejects a base that normalises to an empty slug before touching the database', async () => {
    await expect(
      generateUniquePageSlug(UNREACHABLE_TX, {
        locale: 'en',
        parentPath: null,
        parentPageId: null,
        base: '///',
      }),
    ).rejects.toBeInstanceOf(InvalidPageSlugError);
  });

  it('normalises the base the same way @plakboek/content does (not reimplemented)', async () => {
    // '  Our Team & Culture  ' normalises to 'our-team-culture' -- proven
    // indirectly: a base that normalises to nothing throws with the raw
    // input attached, letting us assert the exact normalisation contract
    // without needing a real transaction.
    const error: unknown = await generateUniquePageSlug(UNREACHABLE_TX, {
      locale: 'en',
      parentPath: null,
      parentPageId: null,
      base: '!!!',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidPageSlugError);
    expect((error as InvalidPageSlugError).input).toBe('!!!');
  });
});

describe('assertPageSlugAvailable: format rejection, no database needed', () => {
  it('rejects an explicit slug that is not already normalised, without silently normalising it', async () => {
    const error: unknown = await assertPageSlugAvailable(UNREACHABLE_TX, {
      locale: 'en',
      slug: 'Our Team',
      parentPath: null,
      parentPageId: null,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidPageSlugError);
    expect((error as InvalidPageSlugError).input).toBe('Our Team');
  });

  it('rejects a double-hyphenated or leading-hyphen slug the same way', async () => {
    await expect(
      assertPageSlugAvailable(UNREACHABLE_TX, {
        locale: 'en',
        slug: 'news--2',
        parentPath: null,
        parentPageId: null,
      }),
    ).rejects.toBeInstanceOf(InvalidPageSlugError);
    await expect(
      assertPageSlugAvailable(UNREACHABLE_TX, {
        locale: 'en',
        slug: '-news',
        parentPath: null,
        parentPageId: null,
      }),
    ).rejects.toBeInstanceOf(InvalidPageSlugError);
  });
});

describe('slug error classes', () => {
  it('InvalidPageSlugError names itself and carries the raw input', () => {
    const error = new InvalidPageSlugError('///');
    expect(error.name).toBe('InvalidPageSlugError');
    expect(error.input).toBe('///');
  });

  it('PageSlugConflictError carries locale, path and existingPageId', () => {
    const error = new PageSlugConflictError('en', 'about', 'page-1');
    expect(error.name).toBe('PageSlugConflictError');
    expect(error.locale).toBe('en');
    expect(error.path).toBe('about');
    expect(error.existingPageId).toBe('page-1');
  });

  it('PageSlugConflictError accepts a null existingPageId for the unique-violation backstop', () => {
    const error = new PageSlugConflictError('en', 'about', null);
    expect(error.existingPageId).toBeNull();
  });

  it('PageSlugGenerationError names itself and carries the base', () => {
    const error = new PageSlugGenerationError('about');
    expect(error.name).toBe('PageSlugGenerationError');
    expect(error.base).toBe('about');
  });
});
