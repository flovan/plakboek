import { describe, expect, it } from 'vitest';
import { ApiHttpError } from '../../src/server/api/http.js';
import {
  editBody,
  parseWith,
  previewBody,
} from '../../src/server/api/schemas.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function batch(ops: readonly unknown[]): unknown {
  return { basePageVersion: 3, ops };
}

describe('editBody', () => {
  it('accepts every op kind', () => {
    const parsed = editBody.safeParse(
      batch([
        {
          op: 'insert',
          position: { parentId: A, previousId: B, nextId: null },
          node: {
            id: B,
            type: 'section',
            props: { a: 1 },
            layout: { columns: '1:2', align: 'start', fill: true },
            children: [{ type: 'column' }],
          },
        },
        { op: 'update', blockId: A, baseVersion: 1, props: { text: 'x' } },
        { op: 'update', blockId: A, baseVersion: 1, layout: null },
        {
          op: 'move',
          blockId: A,
          baseVersion: 2,
          position: { parentId: null },
        },
        { op: 'delete', blockId: A, baseVersion: 1 },
        { op: 'duplicate', blockId: A, newId: B },
      ]),
    );
    expect(parsed.success).toBe(true);
  });

  it('refuses an id that is not a lowercase uuid', () => {
    for (const blockId of ['nope', A.toUpperCase()]) {
      const parsed = editBody.safeParse(
        batch([{ op: 'delete', blockId, baseVersion: 1 }]),
      );
      expect(parsed.success).toBe(false);
    }
  });

  it('refuses an empty batch and one over 50 operations', () => {
    const op = { op: 'delete', blockId: A, baseVersion: 1 };
    expect(editBody.safeParse(batch([])).success).toBe(false);
    expect(
      editBody.safeParse(batch(Array.from({ length: 50 }, () => op))).success,
    ).toBe(true);
    expect(
      editBody.safeParse(batch(Array.from({ length: 51 }, () => op))).success,
    ).toBe(false);
  });

  it('refuses a batch that inserts more than 500 nodes, nested or not', () => {
    const wide = {
      op: 'insert',
      position: { parentId: null },
      node: {
        type: 'section',
        children: Array.from({ length: 500 }, () => ({ type: 'column' })),
      },
    };
    // 1 + 500 nodes
    expect(editBody.safeParse(batch([wide])).success).toBe(false);
    const flat = {
      op: 'insert',
      position: { parentId: null },
      node: { type: 'text' },
    };
    expect(
      editBody.safeParse(batch(Array.from({ length: 50 }, () => flat))).success,
    ).toBe(true);
  });

  it('refuses a node nested beyond the schema bound', () => {
    let node: Record<string, unknown> = { type: 'text' };
    for (let level = 0; level < 40; level += 1) {
      node = { type: 'section', children: [node] };
    }
    const parsed = editBody.safeParse(
      batch([{ op: 'insert', position: { parentId: null }, node }]),
    );
    expect(parsed.success).toBe(false);
  });

  it('refuses a layout key other than columns, align and fill', () => {
    const parsed = editBody.safeParse(
      batch([
        {
          op: 'update',
          blockId: A,
          baseVersion: 1,
          layout: { columns: '1:1', width: 4 },
        },
      ]),
    );
    expect(parsed.success).toBe(false);
  });

  it('refuses props that are not a plain object and a base version below 1', () => {
    for (const bad of [
      { op: 'update', blockId: A, baseVersion: 1, props: [1] },
      { op: 'update', blockId: A, baseVersion: 1, props: 'x' },
      { op: 'update', blockId: A, baseVersion: 0, props: {} },
      { op: 'update', blockId: A, baseVersion: 1.5, props: {} },
    ]) {
      expect(editBody.safeParse(batch([bad])).success).toBe(false);
    }
  });

  it('names keys and codes, never values, when a body is refused', () => {
    const refuse = (): unknown =>
      parseWith(
        editBody,
        batch([{ op: 'update', blockId: 'secret-value', baseVersion: 1 }]),
      );
    expect(refuse).toThrow(ApiHttpError);
    const issues = (() => {
      try {
        refuse();
        return undefined;
      } catch (error) {
        return error instanceof ApiHttpError ? error.issues : undefined;
      }
    })();
    expect(issues?.length).toBeGreaterThan(0);
    expect(JSON.stringify(issues)).not.toContain('secret-value');
  });
});

describe('previewBody', () => {
  it('takes a block id with optional props and layout', () => {
    expect(previewBody.safeParse({ blockId: A }).success).toBe(true);
    expect(
      previewBody.safeParse({ blockId: A, props: { text: 'x' }, layout: null })
        .success,
    ).toBe(true);
    expect(
      previewBody.safeParse({ blockId: A, layout: { fill: true } }).success,
    ).toBe(true);
  });

  it('refuses a missing or malformed id and unknown keys', () => {
    expect(previewBody.safeParse({}).success).toBe(false);
    expect(previewBody.safeParse({ blockId: 'x' }).success).toBe(false);
    expect(previewBody.safeParse({ blockId: A, extra: 1 }).success).toBe(false);
    expect(
      previewBody.safeParse({ blockId: A, layout: { size: 1 } }).success,
    ).toBe(false);
  });
});
