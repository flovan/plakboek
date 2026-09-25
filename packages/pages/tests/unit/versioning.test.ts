import { describe, expect, it } from 'vitest';
import type { BlockDefinition } from '../../src/registry.js';
import { upcastOnRead } from '../../src/versioning.js';

// `upcastOnRead` only ever receives a `BlockDefinition`-shaped object; it
// has no dependency on `defineBlocks`'s own boot-time validation. These
// definitions are hand-built (not run through `defineBlocks`) specifically
// so the `'no-upcaster'` and `'upcaster-threw'` degraded branches stay
// covered even though 04-04's D-10 rule (a declaration's `upcasters` must
// cover every step from 2..schemaVersion contiguously) makes both
// unreachable through any `defineBlocks`-validated, boot-valid config --
// see `tests/integration/tracer-page-block-publish.test.ts`'s comment on
// why its own no-upcaster scenario moved to `'below-floor'`.
function definition(overrides: Partial<BlockDefinition> = {}): BlockDefinition {
  return Object.freeze({
    key: 'note',
    kind: 'block',
    editor: Object.freeze({ label: 'Note' }),
    properties: Object.freeze({}),
    placement: Object.freeze({
      ownerTypes: Object.freeze(['page'] as const),
      allowedParents: 'any',
      allowedChildren: 'none',
    }),
    schemaVersion: 3,
    upcasters: Object.freeze({}),
    ...overrides,
  });
}

describe('upcastOnRead (D-10, D-11, D-12, D-15)', () => {
  it('returns the stored props untouched, not degraded, when the stored version already matches', () => {
    const result = upcastOnRead(definition({ schemaVersion: 1 }), 1, {
      a: 1,
    });
    expect(result).toEqual({ props: { a: 1 }, degraded: false });
  });

  it('applies every upcaster step in order to reach the current schemaVersion', () => {
    const upcasters = {
      2: (props: unknown) => ({
        ...(props as Record<string, unknown>),
        step: 2,
      }),
      3: (props: unknown) => ({
        ...(props as Record<string, unknown>),
        step: 3,
      }),
    };
    const result = upcastOnRead(
      definition({ schemaVersion: 3, upcasters }),
      1,
      { a: 1 },
    );
    expect(result).toEqual({ props: { a: 1, step: 3 }, degraded: false });
  });

  it('degrades with reason below-floor when the stored version is under minSupportedVersion, without walking the chain', () => {
    const result = upcastOnRead(
      definition({ schemaVersion: 3, minSupportedVersion: 3 }),
      1,
      { a: 1 },
    );
    expect(result).toEqual({
      props: { a: 1 },
      degraded: true,
      reason: 'below-floor',
    });
  });

  it('degrades with reason no-upcaster when a step in the chain has no registered upcaster', () => {
    const result = upcastOnRead(
      definition({ schemaVersion: 3, upcasters: { 3: (props) => props } }),
      1,
      { a: 1 },
    );
    expect(result).toEqual({
      props: { a: 1 },
      degraded: true,
      reason: 'no-upcaster',
    });
  });

  it('degrades with a reason naming the thrown message when an upcaster step throws', () => {
    const result = upcastOnRead(
      definition({
        schemaVersion: 2,
        upcasters: {
          2: () => {
            throw new Error('boom');
          },
        },
      }),
      1,
      { a: 1 },
    );
    expect(result).toEqual({
      props: { a: 1 },
      degraded: true,
      reason: 'upcaster-threw: boom',
    });
  });
});
