/**
 * `newRevisionBatchId`'s uniqueness and `pruneBlockRevisions`'s pure,
 * database-free pieces: the `cap <= 0` no-op short-circuit (never issues a
 * statement) and the driver-agnostic affected-row-count reader's two
 * supported shapes (postgres-js's `count`, node-postgres's `rowCount`) plus
 * its failure mode when neither is readable. Everything requiring real
 * Postgres (the ranked-batch delete itself, the manifest exclusion, the
 * publish-kind exclusion) lives in `tests/integration/revisions.test.ts`.
 */
import type { AuditTransaction } from '@plakboek/auth';
import { describe, expect, it, vi } from 'vitest';
import {
  newRevisionBatchId,
  pruneBlockRevisions,
} from '../../src/revisions.js';

function fakeTx(execute: ReturnType<typeof vi.fn>): AuditTransaction {
  return { execute } as unknown as AuditTransaction;
}

describe('newRevisionBatchId', () => {
  it('returns a distinct id on every call', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRevisionBatchId()));
    expect(ids.size).toBe(50);
  });

  it('returns a UUID-shaped string', () => {
    const id = newRevisionBatchId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

describe('pruneBlockRevisions cap <= 0 no-op', () => {
  it('returns 0 and never calls execute when cap is 0', async () => {
    const execute = vi.fn();
    const result = await pruneBlockRevisions(fakeTx(execute), {
      pageId: 'page-1',
      locale: 'en',
      cap: 0,
    });
    expect(result).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns 0 and never calls execute when cap is negative', async () => {
    const execute = vi.fn();
    const result = await pruneBlockRevisions(fakeTx(execute), {
      pageId: 'page-1',
      locale: 'en',
      cap: -1,
    });
    expect(result).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('pruneBlockRevisions affected-row-count reading (driver-agnostic)', () => {
  it('reads postgres-js\'s "count" shape', async () => {
    const execute = vi.fn().mockResolvedValue({ count: 4 });
    const result = await pruneBlockRevisions(fakeTx(execute), {
      pageId: 'page-1',
      locale: 'en',
      cap: 3,
    });
    expect(result).toBe(4);
  });

  it('reads node-postgres\'s "rowCount" shape', async () => {
    const execute = vi.fn().mockResolvedValue({ rowCount: 7 });
    const result = await pruneBlockRevisions(fakeTx(execute), {
      pageId: 'page-1',
      locale: 'en',
      cap: 3,
    });
    expect(result).toBe(7);
  });

  it('throws when neither shape is readable, rather than defaulting to 0', async () => {
    const execute = vi.fn().mockResolvedValue({ neither: true });
    await expect(
      pruneBlockRevisions(fakeTx(execute), {
        pageId: 'page-1',
        locale: 'en',
        cap: 3,
      }),
    ).rejects.toThrow(TypeError);
  });
});
