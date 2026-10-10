import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertNotReservedFirstSegment,
  RESERVED_PAGE_PATH_SEGMENTS,
  ReservedPageSlugError,
  reportReservedPagePaths,
  type ReservedPagePathEvent,
  type ReservedPagePathRow,
} from '../../src/reserved.js';

const ROW: ReservedPagePathRow = {
  pageId: 'page-1',
  locale: 'en',
  path: 'cms/legacy',
  segment: 'cms',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RESERVED_PAGE_PATH_SEGMENTS', () => {
  it('is the frozen pair cms and api', () => {
    expect([...RESERVED_PAGE_PATH_SEGMENTS]).toEqual(['cms', 'api']);
    expect(Object.isFrozen(RESERVED_PAGE_PATH_SEGMENTS)).toBe(true);
  });
});

describe('assertNotReservedFirstSegment (D-23)', () => {
  it.each(['cms', 'api', 'cms/anything', 'api/v1', 'CMS', 'Api/x'])(
    'refuses %s',
    (path) => {
      expect(() => assertNotReservedFirstSegment(path)).toThrow(
        ReservedPageSlugError,
      );
    },
  );

  it.each(['cmsx', 'about/cms', 'docs', 'docs/api', 'apis', 'my-cms'])(
    'allows %s',
    (path) => {
      expect(() => assertNotReservedFirstSegment(path)).not.toThrow();
    },
  );

  it('carries the segment, the path and the operator copy', () => {
    let caught: unknown;
    try {
      assertNotReservedFirstSegment('CMS/team');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReservedPageSlugError);
    const error = caught as ReservedPageSlugError;
    expect(error.name).toBe('ReservedPageSlugError');
    expect(error.segment).toBe('cms');
    expect(error.path).toBe('CMS/team');
    expect(error.message).toBe(
      '@plakboek/pages: The first part of a page address cannot be "cms" or "api". Choose a different address.',
    );
  });
});

describe('reportReservedPagePaths', () => {
  const clock = (): Date => new Date('2026-10-10T08:00:00.000Z');

  it('fires the hook once per row with the event', () => {
    const events: ReservedPagePathEvent[] = [];
    const second: ReservedPagePathRow = {
      pageId: 'page-2',
      locale: 'nl',
      path: 'api',
      segment: 'api',
    };
    reportReservedPagePaths(
      {
        hooks: { onReservedPagePath: (event) => events.push(event) },
        now: clock,
      },
      [ROW, second],
    );
    expect(events).toEqual([
      { ...ROW, occurredAt: clock() },
      { ...second, occurredAt: clock() },
    ]);
  });

  it('writes one console warning per row with the operator copy when no hook is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    reportReservedPagePaths({}, [ROW]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(
      'Page cms/legacy uses the reserved address segment "cms". The page was kept; rename it so it can be reached.',
    );
  });

  it('survives a throwing hook and a rejecting hook', async () => {
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    expect(() =>
      reportReservedPagePaths(
        {
          hooks: {
            onReservedPagePath: () => {
              throw new Error('boom');
            },
          },
        },
        [ROW, ROW],
      ),
    ).not.toThrow();
    expect(error).toHaveBeenCalledTimes(2);

    reportReservedPagePaths(
      {
        hooks: {
          onReservedPagePath: (() =>
            Promise.reject(new Error('nope'))) as unknown as (
            event: ReservedPagePathEvent,
          ) => void,
        },
      },
      [ROW],
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(error).toHaveBeenCalledTimes(3);
  });

  it('does nothing for an empty list', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    reportReservedPagePaths({}, []);
    expect(warn).not.toHaveBeenCalled();
  });
});
