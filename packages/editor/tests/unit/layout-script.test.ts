import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { HOST_TAG } from '../../src/chrome/island.js';
import {
  applyLayout,
  LAYOUT_KEY,
  layoutOf,
  readLayout,
  writeLayout,
} from '../../src/client/shell/layout.js';
import { cspHashOf } from '../../src/server/html-document.js';
import {
  LAYOUT_SCRIPT,
  LAYOUT_SCRIPT_CSP_HASH,
  LAYOUT_STORAGE_KEY,
} from '../../src/server/layout-script.js';

const noop = (): void => undefined;

type FakeHost = { attributes: Record<string, string> };

/** Runs the script in a context with stubbed storage and document. */
function run(storage: { getItem: (key: string) => string | null }): FakeHost {
  const host: FakeHost = { attributes: {} };
  runInNewContext(LAYOUT_SCRIPT, {
    localStorage: storage,
    document: {
      querySelector: (selector: string) => {
        return selector === HOST_TAG
          ? {
              setAttribute: (name: string, value: string) => {
                host.attributes[name] = value;
              },
            }
          : null;
      },
    },
  });
  return host;
}

describe('the pre-paint layout script', () => {
  it('sets data-layout="full" on the editor host when the stored value is exactly full', () => {
    const host = run({
      getItem: (key) => (key === LAYOUT_STORAGE_KEY ? 'full' : null),
    });
    expect(host.attributes).toEqual({ 'data-layout': 'full' });
  });

  it.each([null, 'framed', 'FULL', ' full', 'full ', '', '1'])(
    'leaves the framed layout for the stored value %j',
    (stored) => {
      const host = run({ getItem: () => stored });
      expect(host.attributes).toEqual({});
    },
  );

  it('survives storage that throws, leaving the framed layout', () => {
    const host = run({
      getItem: () => {
        throw new Error('storage is blocked');
      },
    });
    expect(host.attributes).toEqual({});
  });

  it('survives storage that is not there at all', () => {
    expect(() =>
      runInNewContext(LAYOUT_SCRIPT, {
        document: { querySelector: () => null },
      }),
    ).not.toThrow();
  });

  it('does nothing when the host element is missing', () => {
    expect(() =>
      runInNewContext(LAYOUT_SCRIPT, {
        localStorage: { getItem: () => 'full' },
        document: { querySelector: () => null },
      }),
    ).not.toThrow();
  });

  it('is constant text that only reads storage and sets one attribute', () => {
    expect(LAYOUT_SCRIPT).not.toMatch(/innerHTML|document\.write|eval|fetch/);
    expect(LAYOUT_SCRIPT).not.toContain('setItem');
    expect(LAYOUT_SCRIPT).not.toContain('<');
  });

  it('has a CSP hash computed from exactly its text', () => {
    expect(LAYOUT_SCRIPT_CSP_HASH).toBe(cspHashOf(LAYOUT_SCRIPT));
    expect(LAYOUT_SCRIPT_CSP_HASH).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
  });
});

describe('the browser-side layout preference', () => {
  it('reads and writes the key the pre-paint script reads', () => {
    expect(LAYOUT_KEY).toBe(LAYOUT_STORAGE_KEY);
  });

  it('reads full only for exactly full', () => {
    expect(readLayout({ getItem: () => 'full', setItem: noop })).toBe('full');
    for (const stored of [null, 'framed', 'full ', 'x']) {
      expect(readLayout({ getItem: () => stored, setItem: noop })).toBe(
        'framed',
      );
    }
  });

  it('reads framed when storage throws or is unavailable', () => {
    expect(
      readLayout({
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: noop,
      }),
    ).toBe('framed');
    expect(readLayout(null)).toBe('framed');
  });

  it('writes the value under the key and ignores a storage failure', () => {
    const written: [string, string][] = [];
    writeLayout('full', {
      getItem: () => null,
      setItem: (key, value) => {
        written.push([key, value]);
      },
    });
    expect(written).toEqual([[LAYOUT_STORAGE_KEY, 'full']]);
    expect(() =>
      writeLayout('framed', {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota');
        },
      }),
    ).not.toThrow();
    expect(() => writeLayout('full', null)).not.toThrow();
  });

  it('puts the layout on the host and reads it back', () => {
    const attributes = new Map<string, string>();
    const host = {
      setAttribute: (name: string, value: string) => {
        attributes.set(name, value);
      },
      getAttribute: (name: string) => attributes.get(name) ?? null,
    } as unknown as HTMLElement;
    expect(layoutOf(host)).toBe('framed');
    applyLayout(host, 'full');
    expect(attributes.get('data-layout')).toBe('full');
    expect(layoutOf(host)).toBe('full');
    applyLayout(host, 'framed');
    expect(layoutOf(host)).toBe('framed');
  });
});
