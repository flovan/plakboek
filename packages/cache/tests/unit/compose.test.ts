import { describe, expect, it } from 'vitest';
import {
  CachePurgeError,
  composeInvalidators,
  purgePageTags,
} from '../../src/compose.js';
import type { CacheInvalidator } from '../../src/backend.js';

type Spy = CacheInvalidator & { readonly calls: (readonly string[])[] };

function spy(behaviour?: () => Promise<void>): Spy {
  const calls: (readonly string[])[] = [];
  return {
    calls,
    async purge(tags) {
      calls.push(tags);
      if (behaviour !== undefined) await behaviour();
    },
  };
}

describe('composeInvalidators', () => {
  it('calls every layer with the same tags', async () => {
    const a = spy();
    const b = spy();
    await composeInvalidators(a, b).purge(['page:x']);
    expect(a.calls).toEqual([['page:x']]);
    expect(b.calls).toEqual([['page:x']]);
  });

  it('starts every layer before any of them settles', async () => {
    const order: string[] = [];
    let releaseA: () => void = () => undefined;
    const a: CacheInvalidator = {
      async purge() {
        order.push('a:start');
        await new Promise<void>((resolve) => {
          releaseA = resolve;
        });
        order.push('a:end');
      },
    };
    const b: CacheInvalidator = {
      async purge() {
        order.push('b:start');
      },
    };
    const pending = composeInvalidators(a, b).purge(['global']);
    await Promise.resolve();
    expect(order).toEqual(['a:start', 'b:start']);
    releaseA();
    await pending;
    expect(order).toEqual(['a:start', 'b:start', 'a:end']);
  });

  it('still calls the later layer when an earlier one rejects, then rejects with CachePurgeError', async () => {
    const failure = new Error('layer a is down');
    const a = spy(async () => {
      throw failure;
    });
    const b = spy();
    const error: unknown = await composeInvalidators(a, b)
      .purge(['page:x'])
      .catch((caught: unknown) => caught);
    expect(b.calls).toEqual([['page:x']]);
    expect(error).toBeInstanceOf(CachePurgeError);
    expect((error as CachePurgeError).failures).toEqual([failure]);
    expect((error as CachePurgeError).failedLayers).toEqual([0]);
  });

  it('treats a layer that throws synchronously as a rejection', async () => {
    const a: CacheInvalidator = {
      purge() {
        throw new Error('sync failure');
      },
    };
    const b = spy();
    const error: unknown = await composeInvalidators(a, b)
      .purge(['page:x'])
      .catch((caught: unknown) => caught);
    expect(b.calls).toHaveLength(1);
    expect(error).toBeInstanceOf(CachePurgeError);
  });

  it('collects every failure and names only the count in the message', async () => {
    const a = spy(async () => {
      throw new Error('secret detail one');
    });
    const b = spy(async () => {
      throw new Error('secret detail two');
    });
    const error = (await composeInvalidators(a, b)
      .purge(['page:x'])
      .catch((caught: unknown) => caught)) as CachePurgeError;
    expect(error.failures).toHaveLength(2);
    expect(error.failedLayers).toEqual([0, 1]);
    expect(error.message).toContain('2');
    expect(error.message).not.toContain('secret detail');
  });

  it('resolves when every layer resolves, and with no layers at all', async () => {
    await expect(
      composeInvalidators(spy(), spy()).purge(['page:x']),
    ).resolves.toBeUndefined();
    await expect(composeInvalidators().purge(['page:x'])).resolves.toBe(
      undefined,
    );
  });
});

describe('purgePageTags', () => {
  it('purges the page tag of every id', async () => {
    const layer = spy();
    await purgePageTags(layer, ['p1', 'p2']);
    expect(layer.calls).toEqual([['page:p1', 'page:p2']]);
  });

  it('makes no call for an empty id list', async () => {
    const layer = spy();
    await purgePageTags(layer, []);
    expect(layer.calls).toEqual([]);
  });
});
