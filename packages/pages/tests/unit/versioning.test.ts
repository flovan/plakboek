import { describe, expect, it, vi } from 'vitest';
import { defineBlocks, type BlockDefinition } from '../../src/registry.js';
import {
  createUpcastSession,
  DEGRADED_REASONS,
  reportDegradedBlock,
  resolveUpcasterChain,
  upcastOnRead,
  type DegradedBlockEvent,
  type DegradedReason,
} from '../../src/versioning.js';

// `upcastOnRead`/`resolveUpcasterChain` only ever receive a
// `BlockDefinition`-shaped object; they have no dependency on
// `defineBlocks`'s own boot-time validation. These definitions are
// hand-built (not run through `defineBlocks`) specifically so the
// `'no-upcaster'` degraded branch stays covered even though 04-04's D-10
// rule (a declaration's `upcasters` must cover every step from
// 2..schemaVersion contiguously) makes a genuine declared gap unreachable
// through any `defineBlocks`-validated, boot-valid config -- the same
// tension already documented across this phase's other unit suites (see
// `tests/unit/compatibility.test.ts`'s header comment).
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

const emptyProps = Object.freeze({ a: 1 });

describe('DEGRADED_REASONS/DegradedReason', () => {
  it('is a frozen tuple of exactly five reasons', () => {
    expect(DEGRADED_REASONS).toEqual([
      'no-upcaster',
      'upcaster-threw',
      'below-floor',
      'above-current',
      'unknown-block-type',
    ]);
    expect(Object.isFrozen(DEGRADED_REASONS)).toBe(true);
    const reasons: readonly DegradedReason[] = DEGRADED_REASONS;
    expect(reasons).toHaveLength(5);
  });
});

describe('resolveUpcasterChain/upcastOnRead (D-10, D-11, D-12, D-15)', () => {
  it('resolves identity and returns the stored props untouched when the stored version already matches', () => {
    const def = definition({ schemaVersion: 1 });
    expect(resolveUpcasterChain(def, 1)).toEqual({ kind: 'identity' });
    const result = upcastOnRead(def, 1, emptyProps);
    expect(result).toEqual({ props: emptyProps, degraded: false });
    expect(result.props).toBe(emptyProps);
  });

  it('applies every upcaster step in order, each receiving the version it upgrades FROM as its second argument', () => {
    const receivedFromVersions: number[] = [];
    const upcasters = {
      2: (props: unknown, fromVersion: number) => {
        receivedFromVersions.push(fromVersion);
        return { ...(props as Record<string, unknown>), step: 2 };
      },
      3: (props: unknown, fromVersion: number) => {
        receivedFromVersions.push(fromVersion);
        // Asserts the second step receives the FIRST step's output, not
        // the original stored props.
        expect((props as Record<string, unknown>).step).toBe(2);
        return { ...(props as Record<string, unknown>), step: 3 };
      },
    };
    const result = upcastOnRead(
      definition({ schemaVersion: 3, upcasters }),
      1,
      { a: 1 },
    );
    expect(result).toEqual({ props: { a: 1, step: 3 }, degraded: false });
    expect(receivedFromVersions).toEqual([1, 2]);
  });

  it('degrades with reason no-upcaster and returns the stored props unchanged by reference when a step is missing', () => {
    const result = upcastOnRead(
      definition({ schemaVersion: 3, upcasters: { 3: (props) => props } }),
      1,
      emptyProps,
    );
    expect(result.degraded).toBe(true);
    expect(result.degraded && result.reason).toBe('no-upcaster');
    expect(result.props).toBe(emptyProps);
  });

  it('returns the ORIGINAL stored props reference, not the partially upgraded intermediate, when a later step throws after an earlier one succeeded', () => {
    const result = upcastOnRead(
      definition({
        schemaVersion: 3,
        upcasters: {
          2: (props) => ({ ...(props as Record<string, unknown>), step: 2 }),
          3: () => {
            throw new Error('boom at step 3');
          },
        },
      }),
      1,
      emptyProps,
    );
    expect(result.degraded).toBe(true);
    expect(result.degraded && result.reason).toBe('upcaster-threw');
    // The discrimination check: returning `current` (the step-2 output,
    // `{ a: 1, step: 2 }`) here instead of the original `props` reference
    // would make this fail.
    expect(result.props).toBe(emptyProps);
  });

  it('degrades with reason upcaster-threw, the thrown message as detail, and the stored props unchanged by reference when a step throws', () => {
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
      emptyProps,
    );
    expect(result.degraded).toBe(true);
    expect(result.degraded && result.reason).toBe('upcaster-threw');
    expect(result.degraded && result.detail).toBe('boom');
    expect(result.props).toBe(emptyProps);
  });

  it('degrades with reason below-floor and never calls any upcaster when stored under minSupportedVersion', () => {
    const upcaster = vi.fn((props: unknown) => props);
    const result = upcastOnRead(
      definition({
        schemaVersion: 3,
        minSupportedVersion: 2,
        upcasters: { 2: upcaster, 3: upcaster },
      }),
      1,
      emptyProps,
    );
    expect(result.degraded).toBe(true);
    expect(result.degraded && result.reason).toBe('below-floor');
    expect(result.props).toBe(emptyProps);
    expect(upcaster).not.toHaveBeenCalled();
  });

  it('checks the floor BEFORE the step lookup: a below-floor version that would also hit a missing step still reports below-floor, not no-upcaster', () => {
    // schemaVersion 3, minSupportedVersion 2, stored 1, with step 2's
    // upcaster deliberately missing (only step 3 exists). Checking the
    // floor first never reaches the step loop at all; checking it after
    // would hit the missing step-2 upcaster first and report
    // 'no-upcaster' instead.
    const result = upcastOnRead(
      definition({
        schemaVersion: 3,
        minSupportedVersion: 2,
        upcasters: { 3: (props) => props },
      }),
      1,
      emptyProps,
    );
    expect(result.degraded).toBe(true);
    expect(result.degraded && result.reason).toBe('below-floor');
  });

  it('degrades with reason above-current, never treating the stored props as already current, when stored above schemaVersion', () => {
    const result = upcastOnRead(
      definition({ schemaVersion: 2, upcasters: { 2: (p) => p } }),
      5,
      emptyProps,
    );
    expect(result.degraded).toBe(true);
    expect(result.degraded && result.reason).toBe('above-current');
    expect(result.props).toBe(emptyProps);
  });
});

describe('createUpcastSession (04-RESEARCH.md Pattern 5)', () => {
  it('resolves the chain once per (blockType, storedVersion) pair and applies it fresh to each call’s own props', () => {
    defineBlocks([
      {
        key: 'card',
        kind: 'section',
        editor: { label: 'Card' },
        schemaVersion: 2,
        upcasters: {
          2: (props: unknown) => ({
            ...(props as Record<string, unknown>),
            upgraded: true,
          }),
        },
        properties: {},
      },
    ]);

    const session = createUpcastSession();
    const outcomeOne = session.upcast('card', 1, { a: 1 });
    const outcomeTwo = session.upcast('card', 1, { a: 2 });

    expect(outcomeOne).toEqual({
      props: { a: 1, upgraded: true },
      degraded: false,
    });
    expect(outcomeTwo).toEqual({
      props: { a: 2, upgraded: true },
      degraded: false,
    });
    // Two rows at the identical (blockType, storedVersion) pair with
    // different props never share an output -- the discrimination check:
    // memoising the applied RESULT instead of the resolved chain would
    // make `outcomeTwo` equal `outcomeOne`'s props.
    expect(outcomeTwo.props).not.toEqual(outcomeOne.props);
  });

  it('resolves degraded with reason unknown-block-type for an unregistered blockType, via UnknownBlockTypeError', () => {
    defineBlocks([
      {
        key: 'known',
        editor: { label: 'Known' },
        schemaVersion: 1,
        properties: {},
      },
    ]);
    const session = createUpcastSession();
    const outcome = session.upcast('totally-unregistered', 1, emptyProps);
    expect(outcome.degraded).toBe(true);
    expect(outcome.degraded && outcome.reason).toBe('unknown-block-type');
    expect(outcome.props).toBe(emptyProps);
  });

  it('keeps each session’s memo independent: a second session against a changed registry resolves fresh, and the first session keeps its own already-resolved chain', () => {
    defineBlocks([
      {
        key: 'widget',
        kind: 'section',
        editor: { label: 'Widget (A)' },
        schemaVersion: 2,
        upcasters: {
          2: (props: unknown) => ({
            ...(props as Record<string, unknown>),
            variant: 'a',
          }),
        },
        properties: {},
      },
    ]);
    const sessionA = createUpcastSession();
    const firstOutcome = sessionA.upcast('widget', 1, { seed: 1 });
    expect(firstOutcome).toEqual({
      props: { seed: 1, variant: 'a' },
      degraded: false,
    });

    // Re-register the same key with a different upcaster -- a genuinely
    // different resolution for the identical (blockType, storedVersion)
    // pair.
    defineBlocks([
      {
        key: 'widget',
        kind: 'section',
        editor: { label: 'Widget (B)' },
        schemaVersion: 2,
        upcasters: {
          2: (props: unknown) => ({
            ...(props as Record<string, unknown>),
            variant: 'b',
          }),
        },
        properties: {},
      },
    ]);

    // A fresh session resolves against the NEW registration -- proving
    // nothing is cached across a process (module-level).
    const sessionB = createUpcastSession();
    const freshOutcome = sessionB.upcast('widget', 1, { seed: 2 });
    expect(freshOutcome).toEqual({
      props: { seed: 2, variant: 'b' },
      degraded: false,
    });

    // `sessionA`'s own memo is unaffected by the re-registration that
    // happened after it already resolved this pair -- proving the memo is
    // genuinely per-session, not read fresh from the registry every call.
    const repeatOnSessionA = sessionA.upcast('widget', 1, { seed: 3 });
    expect(repeatOnSessionA).toEqual({
      props: { seed: 3, variant: 'a' },
      degraded: false,
    });
  });
});

describe('reportDegradedBlock', () => {
  const baseEvent: DegradedBlockEvent = {
    blockId: 'block-1',
    blockType: 'note',
    storedVersion: 1,
    currentVersion: 3,
    reason: 'no-upcaster',
    occurredAt: new Date('2026-09-25T00:00:00.000Z'),
  };

  it('returns normally when a hook throws', () => {
    expect(() =>
      reportDegradedBlock(
        {
          onDegradedBlock: () => {
            throw new Error('hook boom');
          },
        },
        baseEvent,
      ),
    ).not.toThrow();
  });

  it('calls the provided hook with the event when hooks are given', () => {
    const received: DegradedBlockEvent[] = [];
    reportDegradedBlock(
      { onDegradedBlock: (event) => received.push(event) },
      baseEvent,
    );
    expect(received).toEqual([baseEvent]);
  });

  it('falls back to the default logger without throwing when hooks are undefined', () => {
    expect(() => reportDegradedBlock(undefined, baseEvent)).not.toThrow();
  });
});
