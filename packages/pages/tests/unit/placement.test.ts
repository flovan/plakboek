/**
 * `assertPlacementAllowed`'s pure decision logic (BLOCK-05, D-08, D-18,
 * D-19), exercised against hand-built `PlacementContext` values -- no
 * database. `countAncestorSections`'s own query shape is covered by
 * `tests/integration/placement.test.ts` against real Postgres.
 */
import { describe, expect, it } from 'vitest';
import {
  assertPlacementAllowed,
  BlockDepthExceededError,
  BlockPlacementError,
  checkPlacement,
  ROOT_PARENT_SENTINEL,
  SectionNestingDepthExceededError,
  SectionRequiredError,
  type PlacementCheckInput,
  type PlacementContext,
  type PlacementRefusalReason,
} from '../../src/placement.js';
import type { BlockDefinition } from '../../src/registry.js';

function definition(overrides: Partial<BlockDefinition> = {}): BlockDefinition {
  return Object.freeze({
    key: 'heading',
    kind: 'block',
    editor: Object.freeze({ label: 'Heading' }),
    properties: Object.freeze({}),
    placement: Object.freeze({
      ownerTypes: Object.freeze(['page'] as const),
      allowedParents: 'any',
      allowedChildren: 'none',
    }),
    schemaVersion: 1,
    upcasters: Object.freeze({}),
    layoutSupport: Object.freeze({ fill: false }),
    starterChildren: Object.freeze([]),
    ...overrides,
  });
}

function section(overrides: Partial<BlockDefinition> = {}): BlockDefinition {
  return definition({
    key: 'section',
    kind: 'section',
    placement: Object.freeze({
      ownerTypes: Object.freeze(['page'] as const),
      allowedParents: 'any',
      allowedChildren: 'any',
    }),
    ...overrides,
  });
}

function baseContext(overrides: Partial<PlacementContext>): PlacementContext {
  return {
    owner: { ownerType: 'page', ownerId: 'owner-1', locale: 'en' },
    child: definition(),
    parent: null,
    section: null,
    parentDepth: null,
    parentSectionDepth: 0,
    sectionNestingDepth: 2,
    blockDepthCeiling: 12,
    columnsEnabled: false,
    ...overrides,
  };
}

/** Captures a thrown value outside any `try`/`catch` an `expect` call would
 * sit inside -- oxlint's `vitest/no-conditional-expect` flags `expect`
 * calls inside a `catch` block, so every assertion on a caught error's
 * fields runs against this function's return value instead. */
function captureError(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('assertPlacementAllowed (BLOCK-05, D-08, D-18, D-19)', () => {
  it('refuses a non-section block with no parent directly under a page owner (D-19)', () => {
    expect(() =>
      assertPlacementAllowed(
        baseContext({ child: definition({ key: 'heading' }), parent: null }),
      ),
    ).toThrow(SectionRequiredError);
  });

  it('allows a section with no parent directly under a page owner', () => {
    expect(() =>
      assertPlacementAllowed(baseContext({ child: section(), parent: null })),
    ).not.toThrow();
  });

  it('allows a heading inside a section', () => {
    expect(() =>
      assertPlacementAllowed(
        baseContext({
          child: definition({ key: 'heading' }),
          parent: section(),
          parentDepth: 0,
          parentSectionDepth: 1,
        }),
      ),
    ).not.toThrow();
  });

  it('refuses a section inside a heading, whose allowedChildren defaults to none, naming parent and child', () => {
    const heading = definition({ key: 'heading' });
    const error = captureError(() =>
      assertPlacementAllowed(
        baseContext({
          child: section(),
          parent: heading,
          parentDepth: 0,
          parentSectionDepth: 0,
        }),
      ),
    );
    expect(error).toBeInstanceOf(BlockPlacementError);
    const placementError = error as BlockPlacementError;
    expect(placementError.reason).toBe('parent-rejects-child');
    expect(placementError.parentKey).toBe('heading');
    expect(placementError.childKey).toBe('section');
  });

  it('refuses a card declaring allowedParents: [section] under a grid', () => {
    const grid = definition({
      key: 'grid',
      placement: Object.freeze({
        ownerTypes: Object.freeze(['page'] as const),
        allowedParents: 'any',
        allowedChildren: 'any',
      }),
    });
    const card = definition({
      key: 'card',
      placement: Object.freeze({
        ownerTypes: Object.freeze(['page'] as const),
        allowedParents: Object.freeze(['section']),
        allowedChildren: 'none',
      }),
    });
    expect(() =>
      assertPlacementAllowed(
        baseContext({
          child: card,
          parent: grid,
          parentDepth: 1,
          parentSectionDepth: 1,
        }),
      ),
    ).toThrow(BlockPlacementError);
  });

  it('allows a card declaring allowedParents: [section] under a section', () => {
    const card = definition({
      key: 'card',
      placement: Object.freeze({
        ownerTypes: Object.freeze(['page'] as const),
        allowedParents: Object.freeze(['section']),
        allowedChildren: 'none',
      }),
    });
    expect(() =>
      assertPlacementAllowed(
        baseContext({
          child: card,
          parent: section(),
          parentDepth: 0,
          parentSectionDepth: 1,
        }),
      ),
    ).not.toThrow();
  });

  it('a grid declaring allowedChildren: [card] accepts a card', () => {
    const grid = definition({
      key: 'grid',
      placement: Object.freeze({
        ownerTypes: Object.freeze(['page'] as const),
        allowedParents: 'any',
        allowedChildren: Object.freeze(['card']),
      }),
    });
    const card = definition({ key: 'card' });
    expect(() =>
      assertPlacementAllowed(
        baseContext({
          child: card,
          parent: grid,
          parentDepth: 1,
          parentSectionDepth: 1,
        }),
      ),
    ).not.toThrow();
  });

  it('a grid declaring allowedChildren: [card] refuses a heading', () => {
    const grid = definition({
      key: 'grid',
      placement: Object.freeze({
        ownerTypes: Object.freeze(['page'] as const),
        allowedParents: 'any',
        allowedChildren: Object.freeze(['card']),
      }),
    });
    const heading = definition({ key: 'heading' });
    expect(() =>
      assertPlacementAllowed(
        baseContext({
          child: heading,
          parent: grid,
          parentDepth: 1,
          parentSectionDepth: 1,
        }),
      ),
    ).toThrow(BlockPlacementError);
  });

  it('refuses a block declaring ownerTypes: [] under every owner type, naming the owner type', () => {
    const restricted = definition({
      key: 'restricted',
      placement: Object.freeze({
        ownerTypes: Object.freeze([]),
        allowedParents: 'any',
        allowedChildren: 'none',
      }),
    });
    const error = captureError(() =>
      assertPlacementAllowed(
        baseContext({
          child: restricted,
          parent: section(),
          parentDepth: 0,
          parentSectionDepth: 1,
        }),
      ),
    );
    expect(error).toBeInstanceOf(BlockPlacementError);
    const placementError = error as BlockPlacementError;
    expect(placementError.reason).toBe('owner-type');
    expect(placementError.ownerType).toBe('page');
  });

  it('allows a section inside a section at sectionNestingDepth: 2', () => {
    expect(() =>
      assertPlacementAllowed(
        baseContext({
          child: section({ key: 'inner-section' }),
          parent: section({ key: 'outer-section' }),
          parentDepth: 0,
          parentSectionDepth: 1,
          sectionNestingDepth: 2,
        }),
      ),
    ).not.toThrow();
  });

  it('refuses a third nested section, carrying cap and attempted', () => {
    const error = captureError(() =>
      assertPlacementAllowed(
        baseContext({
          child: section({ key: 'third-section' }),
          parent: section({ key: 'second-section' }),
          parentDepth: 1,
          parentSectionDepth: 2,
          sectionNestingDepth: 2,
        }),
      ),
    );
    expect(error).toBeInstanceOf(SectionNestingDepthExceededError);
    const depthError = error as SectionNestingDepthExceededError;
    expect(depthError.cap).toBe(2);
    expect(depthError.attempted).toBe(3);
  });

  it('counts section depth by sections only: a section nested inside a section inside a non-section block still counts as depth 2', () => {
    // parentSectionDepth: 1 represents "one section ancestor" even though
    // the immediate parent here is a non-section block sitting inside that
    // one section -- the caller (countAncestorSections) is responsible for
    // this section-only count; this context simulates its result.
    expect(() =>
      assertPlacementAllowed(
        baseContext({
          child: section({ key: 'nested-section' }),
          parent: definition({
            key: 'wrapper',
            placement: Object.freeze({
              ownerTypes: Object.freeze(['page'] as const),
              allowedParents: 'any',
              allowedChildren: 'any',
            }),
          }),
          parentDepth: 1,
          parentSectionDepth: 1,
          sectionNestingDepth: 2,
        }),
      ),
    ).not.toThrow();
  });

  it('inserts a block reaching blockDepthCeiling', () => {
    expect(() =>
      assertPlacementAllowed(
        baseContext({
          child: definition({ key: 'deep' }),
          parent: section(),
          parentDepth: 11,
          parentSectionDepth: 1,
          blockDepthCeiling: 12,
        }),
      ),
    ).not.toThrow();
  });

  it('refuses the next block past blockDepthCeiling, carrying ceiling and attempted', () => {
    const error = captureError(() =>
      assertPlacementAllowed(
        baseContext({
          child: definition({ key: 'too-deep' }),
          parent: section(),
          parentDepth: 12,
          parentSectionDepth: 1,
          blockDepthCeiling: 12,
        }),
      ),
    );
    expect(error).toBeInstanceOf(BlockDepthExceededError);
    const depthError = error as BlockDepthExceededError;
    expect(depthError.ceiling).toBe(12);
    expect(depthError.attempted).toBe(13);
  });

  it('resolves the @root sentinel for a child whose allowedParents is a closed list including it', () => {
    const rootOnly = definition({
      key: 'root-only',
      kind: 'section',
      placement: Object.freeze({
        ownerTypes: Object.freeze(['page'] as const),
        allowedParents: Object.freeze([ROOT_PARENT_SENTINEL]),
        allowedChildren: 'any',
      }),
    });
    expect(() =>
      assertPlacementAllowed(baseContext({ child: rootOnly, parent: null })),
    ).not.toThrow();
  });

  it('refuses a child whose allowedParents closed list omits @root when inserted at the root', () => {
    const nestedOnly = definition({
      key: 'nested-only',
      kind: 'section',
      placement: Object.freeze({
        ownerTypes: Object.freeze(['page'] as const),
        allowedParents: Object.freeze(['section']),
        allowedChildren: 'any',
      }),
    });
    expect(() =>
      assertPlacementAllowed(baseContext({ child: nestedOnly, parent: null })),
    ).toThrow(BlockPlacementError);
  });
});

function column(overrides: Partial<BlockDefinition> = {}): BlockDefinition {
  return definition({
    key: 'column',
    kind: 'column',
    placement: Object.freeze({
      ownerTypes: Object.freeze(['page'] as const),
      allowedParents: 'any',
      allowedChildren: 'any',
    }),
    ...overrides,
  });
}

function checkInput(
  overrides: Partial<PlacementCheckInput>,
): PlacementCheckInput {
  return {
    ownerType: 'page',
    child: definition(),
    parent: null,
    section: null,
    parentDepth: null,
    parentSectionDepth: 0,
    sectionNestingDepth: 2,
    blockDepthCeiling: 12,
    columnsEnabled: true,
    ...overrides,
  };
}

describe('checkPlacement: the pure decision behind every write (EDIT-11, D-01..D-03)', () => {
  const cases: readonly {
    readonly reason: PlacementRefusalReason;
    readonly input: PlacementCheckInput;
  }[] = [
    {
      reason: 'owner-type',
      input: checkInput({
        child: definition({
          placement: Object.freeze({
            ownerTypes: Object.freeze([]),
            allowedParents: 'any',
            allowedChildren: 'none',
          }),
        }),
        parent: column(),
        section: section(),
      }),
    },
    { reason: 'section-required', input: checkInput({ child: column() }) },
    {
      reason: 'column-requires-section',
      input: checkInput({
        child: column(),
        parent: definition({ key: 'text' }),
        parentDepth: 1,
        parentSectionDepth: 1,
      }),
    },
    {
      reason: 'section-requires-columns',
      input: checkInput({
        parent: section(),
        parentDepth: 0,
        parentSectionDepth: 1,
      }),
    },
    {
      reason: 'parent-rejects-child',
      input: checkInput({
        parent: column(),
        section: section({
          placement: Object.freeze({
            ownerTypes: Object.freeze(['page'] as const),
            allowedParents: 'any',
            allowedChildren: Object.freeze(['other']),
          }),
        }),
        parentDepth: 1,
        parentSectionDepth: 1,
      }),
    },
    {
      reason: 'child-rejects-parent',
      input: checkInput({
        child: definition({
          placement: Object.freeze({
            ownerTypes: Object.freeze(['page'] as const),
            allowedParents: Object.freeze(['list']),
            allowedChildren: 'none',
          }),
        }),
        parent: column(),
        section: section(),
        parentDepth: 1,
        parentSectionDepth: 1,
      }),
    },
    {
      reason: 'section-nesting',
      input: checkInput({
        child: section({ key: 'third' }),
        parent: column(),
        section: section(),
        parentDepth: 3,
        parentSectionDepth: 2,
      }),
    },
    {
      reason: 'block-depth',
      input: checkInput({
        parent: column(),
        section: section(),
        parentDepth: 12,
        parentSectionDepth: 1,
      }),
    },
  ];

  it.each(cases)('answers $reason', ({ reason, input }) => {
    expect(checkPlacement(input)).toBe(reason);
  });

  it('judges a block under a column against the column section and accepts a legal one', () => {
    expect(
      checkPlacement(
        checkInput({
          parent: column(),
          section: section(),
          parentDepth: 1,
          parentSectionDepth: 1,
        }),
      ),
    ).toBeNull();
  });

  it('refuses a block under a column whose section is unknown', () => {
    expect(
      checkPlacement(
        checkInput({
          parent: column(),
          section: null,
          parentDepth: 1,
          parentSectionDepth: 1,
        }),
      ),
    ).toBe('column-requires-section');
  });

  it('applies none of the column rules when the registry holds no column kind', () => {
    expect(
      checkPlacement(
        checkInput({
          columnsEnabled: false,
          parent: section(),
          parentDepth: 0,
          parentSectionDepth: 1,
        }),
      ),
    ).toBeNull();
  });

  it('never counts a column toward the section nesting cap', () => {
    expect(
      checkPlacement(
        checkInput({
          child: column(),
          parent: section(),
          parentDepth: 0,
          parentSectionDepth: 2,
          sectionNestingDepth: 2,
        }),
      ),
    ).toBeNull();
  });

  it('evaluates in the documented order: owner type, section-required, column rules, nesting, depth', () => {
    const noOwner = definition({
      kind: 'column',
      placement: Object.freeze({
        ownerTypes: Object.freeze([]),
        allowedParents: 'any',
        allowedChildren: 'any',
      }),
    });
    expect(checkPlacement(checkInput({ child: noOwner }))).toBe('owner-type');
    expect(checkPlacement(checkInput({ child: column() }))).toBe(
      'section-required',
    );
    expect(
      checkPlacement(
        checkInput({
          child: section({ key: 'deep' }),
          parent: column(),
          section: section(),
          parentDepth: 20,
          parentSectionDepth: 2,
        }),
      ),
    ).toBe('section-nesting');
  });

  it.each(cases)(
    'assertPlacementAllowed throws for $reason',
    ({ reason, input }) => {
      const error = captureError(() =>
        assertPlacementAllowed({
          owner: { ownerType: input.ownerType, ownerId: 'o', locale: 'en' },
          child: input.child,
          parent: input.parent,
          section: input.section,
          parentDepth: input.parentDepth,
          parentSectionDepth: input.parentSectionDepth,
          sectionNestingDepth: input.sectionNestingDepth,
          blockDepthCeiling: input.blockDepthCeiling,
          columnsEnabled: input.columnsEnabled,
        }),
      );
      const mapped =
        reason === 'section-required'
          ? 'SectionRequiredError'
          : reason === 'section-nesting'
            ? 'SectionNestingDepthExceededError'
            : reason === 'block-depth'
              ? 'BlockDepthExceededError'
              : `BlockPlacementError:${reason}`;
      const actual =
        error instanceof BlockPlacementError
          ? `BlockPlacementError:${error.reason}`
          : error instanceof Error
            ? error.name
            : 'none';
      expect(actual).toBe(mapped);
    },
  );
});
