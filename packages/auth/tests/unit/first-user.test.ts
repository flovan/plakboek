import { drizzle } from 'drizzle-orm/pg-proxy';
import { describe, expect, it } from 'vitest';
import {
  createUserWithRole,
  type UserCreationExecutor,
} from '../../src/first-user.js';

type Statement = { readonly sql: string; readonly params: unknown[] };

/**
 * A Drizzle query builder over a callback driver that records every
 * statement. The installation already has a user, and a transaction runs
 * its callback on the database itself.
 */
function recordingDatabase(): {
  readonly db: UserCreationExecutor;
  readonly statements: Statement[];
} {
  const statements: Statement[] = [];
  const db = drizzle((query, params) => {
    statements.push({ sql: query, params });
    if (query.includes('EXISTS (SELECT 1 FROM "user")')) {
      return Promise.resolve({ rows: [[true]] });
    }
    return Promise.resolve({ rows: [] });
  });
  Object.defineProperty(db, 'transaction', {
    value: async (run: (tx: unknown) => Promise<unknown>) => await run(db),
  });
  return { db: db as unknown as UserCreationExecutor, statements };
}

/** The value bound to `column` in the first insert into `table`. */
function insertedValue(
  statements: readonly Statement[],
  table: string,
  column: string,
): unknown {
  const insert = statements.find((statement) =>
    statement.sql.startsWith(`insert into "${table}"`),
  );
  const match = /\(([^)]*)\) values \(([^)]*)\)/.exec(insert?.sql ?? '');
  const columns = (match?.[1] ?? '').split(', ');
  const placeholder = (match?.[2] ?? '').split(', ')[
    columns.indexOf(`"${column}"`)
  ];
  return placeholder?.startsWith('$') === true
    ? insert?.params[Number(placeholder.slice(1)) - 1]
    : undefined;
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('createUserWithRole address form (AUTH-02)', () => {
  it('stores the address trimmed and lower-cased', async () => {
    const { db, statements } = recordingDatabase();

    await createUserWithRole(db, {
      id: 'user-ada',
      email: ' Ada@Example.TEST ',
      name: 'Ada',
      roleKey: 'editor',
    });

    expect(insertedValue(statements, 'user', 'email')).toBe('ada@example.test');
  });

  it.each([
    ['an empty string', ''],
    ['spaces only', '   '],
    ['tabs and line breaks only', '\t\n '],
    ['a value that is not a string', 42],
  ])(
    'rejects %s as the address before any statement',
    async (_label, email) => {
      const { db, statements } = recordingDatabase();

      const error = await caught(() =>
        createUserWithRole(db, {
          id: 'user-blank',
          email: email as string,
          name: 'Blank',
          roleKey: 'editor',
        }),
      );

      expect(error).toBeInstanceOf(TypeError);
      expect((error as TypeError).message).toMatch(/^@plakboek\/auth: /);
      expect((error as TypeError).message).toContain('email');
      expect(statements).toEqual([]);
    },
  );

  it('does not quote the supplied value when it rejects a blank address', async () => {
    const { db } = recordingDatabase();
    const blank = '    ';

    const error = await caught(() =>
      createUserWithRole(db, {
        id: 'user-blank',
        email: blank,
        name: 'Blank',
        roleKey: 'editor',
      }),
    );

    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).not.toContain(blank);
    expect((error as TypeError).message).not.toContain(' ');
  });
});
