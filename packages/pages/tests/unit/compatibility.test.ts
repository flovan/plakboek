/**
 * `checkBlockCompatibility`'s pure classification logic, exercised directly
 * against hand-built `BlockDefinition`s (not run through `defineBlocks`).
 *
 * D-10 (04-04 Task 1) requires a declaration's `upcasters` to cover every
 * step from 2..schemaVersion contiguously at declare time, so a real
 * "missing upcaster step below the current schemaVersion" declaration can
 * never reach `checkBlockCompatibility` through any `defineBlocks`-validated
 * config -- `defineBlocks` itself refuses it first with `UPCASTER_GAP`. This
 * mirrors the same tension already documented in
 * `tests/unit/versioning.test.ts` and this plan's own
 * `tests/integration/registry-replace.test.ts` header comment. A hand-built
 * `BlockDefinition` (bypassing `defineBlocks`) is what keeps
 * `checkBlockCompatibility`'s own missing-step walk covered despite that.
 */
import { describe, expect, it, vi } from 'vitest';
import { checkBlockCompatibility } from '../../src/compatibility.js';
import type { BlockDefinition } from '../../src/registry.js';

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

function fakeDb(rows: readonly Record<string, unknown>[]) {
  return { execute: vi.fn().mockResolvedValue(rows) } as unknown as Parameters<
    typeof checkBlockCompatibility
  >[0];
}

describe('checkBlockCompatibility classification (BLOCK-09, D-06, D-15)', () => {
  it('reports a stored version missing an upcaster step as incompatible, naming the missing step', async () => {
    const db = fakeDb([{ block_type: 'note', schema_version: 1, count: 1 }]);
    const report = await checkBlockCompatibility(db, [
      definition({ schemaVersion: 3, upcasters: { 3: (props) => props } }),
    ]);
    expect(report.incompatible).toEqual([
      {
        blockKey: 'note',
        storedVersions: [1],
        currentVersion: 3,
        missingSteps: [2],
      },
    ]);
    expect(report.belowFloor).toEqual([]);
  });

  it('reports a stored version above schemaVersion as incompatible with no missing steps (rollback, no downcast path)', async () => {
    const db = fakeDb([{ block_type: 'note', schema_version: 5, count: 2 }]);
    const report = await checkBlockCompatibility(db, [
      definition({ schemaVersion: 3, upcasters: { 2: (p) => p, 3: (p) => p } }),
    ]);
    expect(report.incompatible).toEqual([
      {
        blockKey: 'note',
        storedVersions: [5],
        currentVersion: 3,
        missingSteps: [],
      },
    ]);
  });

  it('classifies a stored version below minSupportedVersion as belowFloor, not incompatible, without walking the chain', async () => {
    const db = fakeDb([{ block_type: 'note', schema_version: 1, count: 4 }]);
    const report = await checkBlockCompatibility(db, [
      definition({
        schemaVersion: 3,
        minSupportedVersion: 3,
        upcasters: { 2: (p) => p, 3: (p) => p },
      }),
    ]);
    expect(report.belowFloor).toEqual([
      {
        blockKey: 'note',
        storedVersions: [1],
        minSupportedVersion: 3,
        instanceCount: 4,
      },
    ]);
    expect(report.incompatible).toEqual([]);
  });

  it('reports nothing for a stored version matching schemaVersion exactly', async () => {
    const db = fakeDb([{ block_type: 'note', schema_version: 3, count: 9 }]);
    const report = await checkBlockCompatibility(db, [
      definition({ schemaVersion: 3 }),
    ]);
    expect(report.incompatible).toEqual([]);
    expect(report.belowFloor).toEqual([]);
  });

  it('issues one grouped read regardless of how many block types/versions are stored', async () => {
    const db = fakeDb([
      { block_type: 'note', schema_version: 1, count: 1 },
      { block_type: 'card', schema_version: 2, count: 1 },
    ]);
    await checkBlockCompatibility(db, [
      definition({ key: 'note', schemaVersion: 1 }),
      definition({ key: 'card', schemaVersion: 2, upcasters: { 2: (p) => p } }),
    ]);
    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('ignores a block_type present in the database but absent from the registered definitions', async () => {
    const db = fakeDb([
      { block_type: 'ghost-block', schema_version: 1, count: 1 },
    ]);
    const report = await checkBlockCompatibility(db, [
      definition({ key: 'note' }),
    ]);
    expect(report.incompatible).toEqual([]);
    expect(report.belowFloor).toEqual([]);
  });
});
