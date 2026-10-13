import { describe, expect, it, vi } from 'vitest';
import { loadBlockEditModules } from '../../src/client/frame/block-edit-loader.js';

const enter = (): void => undefined;

function module(blockType: string, hooks: Record<string, unknown> = { enter }) {
  return async (): Promise<unknown> => ({ default: { blockType, hooks } });
}

describe('loadBlockEditModules', () => {
  it('keeps a valid module under its block type', async () => {
    const report = vi.fn();
    const loaded = await loadBlockEditModules(
      { '/blocks/accordion.edit.ts': module('accordion') },
      report,
    );
    expect(loaded.get('accordion')).toEqual({ enter });
    expect(report).not.toHaveBeenCalled();
  });

  it('skips an invalid default export and reports its key', async () => {
    const report = vi.fn();
    const loaded = await loadBlockEditModules(
      {
        '/blocks/no-default.edit.ts': async () => ({}),
        '/blocks/bad-hook.edit.ts': module('tabs', { enter: 'nope' }),
        '/blocks/no-type.edit.ts': async () => ({ default: { hooks: {} } }),
        '/blocks/ok.edit.ts': module('carousel'),
      },
      report,
    );
    expect([...loaded.keys()]).toEqual(['carousel']);
    expect(report).toHaveBeenCalledTimes(3);
    const messages = report.mock.calls.map(([message]) => String(message));
    expect(messages[0]).toContain('/blocks/no-default.edit.ts');
    expect(messages[1]).toContain('/blocks/bad-hook.edit.ts');
    expect(messages[2]).toContain('/blocks/no-type.edit.ts');
  });

  it('reports a rejected loader by key without its error message', async () => {
    const report = vi.fn();
    const loaded = await loadBlockEditModules(
      {
        '/blocks/broken.edit.ts': async () => {
          throw new Error('secret host detail');
        },
        '/blocks/ok.edit.ts': module('carousel'),
      },
      report,
    );
    expect(loaded.has('carousel')).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
    const message = String(report.mock.calls[0]?.[0]);
    expect(message).toContain('/blocks/broken.edit.ts');
    expect(message).not.toContain('secret host detail');
  });

  it('keeps the first module for a repeated block type and reports the second', async () => {
    const report = vi.fn();
    const second = (): void => undefined;
    const loaded = await loadBlockEditModules(
      {
        '/blocks/a.edit.ts': module('accordion', { enter }),
        '/blocks/b.edit.ts': module('accordion', { enter: second }),
      },
      report,
    );
    expect(loaded.get('accordion')).toEqual({ enter });
    expect(report).toHaveBeenCalledTimes(1);
    const message = String(report.mock.calls[0]?.[0]);
    expect(message).toContain('/blocks/b.edit.ts');
    expect(message).toContain('accordion');
  });
});
