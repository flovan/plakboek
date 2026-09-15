import { createHash, randomUUID } from 'node:crypto';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SET_PASSWORD_TOKEN_TTL_SECONDS } from '../../src/config.js';
import { createUserWithRole } from '../../src/first-user.js';
import {
  InvalidOrExpiredTokenError,
  consumeSingleUseToken,
  generateTokenValue,
  issueSingleUseToken,
  type TokenPurpose,
  type TokenTransaction,
} from '../../src/tokens.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

type Fixture = {
  readonly testDatabase: TestDatabase;
  readonly handle: Db;
  readonly subjectA: string;
  readonly subjectB: string;
};

type StoredToken = {
  readonly identifier: string;
  readonly value: string;
  readonly expiresAtMs: number;
};

const TTL = SET_PASSWORD_TOKEN_TTL_SECONDS;

let current: Fixture | undefined;

function fixture(): Fixture {
  if (current === undefined) {
    throw new Error('the per-test database fixture is not set up');
  }
  return current;
}

async function createSubject(handle: Db, name: string): Promise<string> {
  const created = await createUserWithRole(handle.db, {
    id: randomUUID(),
    email: `${name.toLowerCase()}@example.com`,
    name,
    roleKey: 'editor',
  });
  return created.userId;
}

beforeEach(async () => {
  const testDatabase = await createTestDatabase();
  try {
    await runMigrations({ connectionString: testDatabase.connectionString });
    const handle = createDb({
      connectionString: testDatabase.connectionString,
    });
    // A test-only table recording each time an authorised action ran.
    await handle.sql`
      CREATE TABLE consumption_marker (
        subject_id text NOT NULL,
        label text NOT NULL
      )
    `;
    current = {
      testDatabase,
      handle,
      subjectA: await createSubject(handle, 'Alpha'),
      subjectB: await createSubject(handle, 'Bravo'),
    };
  } catch (error) {
    await testDatabase.drop();
    throw error;
  }
});

afterEach(async () => {
  const finished = current;
  current = undefined;
  vi.restoreAllMocks();
  if (finished !== undefined) {
    await finished.handle.close();
    await finished.testDatabase.drop();
  }
});

/** An independent computation of the stored identifier, not the module's. */
function digestIdentifier(purpose: TokenPurpose, token: string): string {
  return `${purpose}:${createHash('sha256').update(token).digest('base64url')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tokensFor(
  subjectId: string,
  purpose: TokenPurpose,
): Promise<StoredToken[]> {
  const rows = await fixture().handle.sql<StoredToken[]>`
    SELECT identifier, value,
           (extract(epoch FROM expires_at) * 1000)::float8 AS "expiresAtMs"
    FROM verification
    WHERE value = ${subjectId} AND identifier LIKE ${`${purpose}:%`}
    ORDER BY created_at
  `;
  return [...rows];
}

async function markerCount(): Promise<number> {
  const [row] = await fixture().handle.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM consumption_marker
  `;
  return row?.count ?? 0;
}

async function insertMarker(
  tx: TokenTransaction,
  subjectId: string,
  label: string,
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO consumption_marker (subject_id, label) VALUES (${subjectId}, ${label})`,
  );
}

async function issue(
  subjectId: string,
  purpose: TokenPurpose = 'set-password',
  now?: () => Date,
): Promise<string> {
  const { handle } = fixture();
  const issued = await handle.db.transaction(
    async (tx) =>
      await issueSingleUseToken(
        tx,
        { subjectId, purpose, ttlSeconds: TTL },
        now === undefined ? undefined : { now },
      ),
  );
  return issued.token;
}

async function consumeRecording(
  token: string,
  purpose: TokenPurpose = 'set-password',
  now?: () => Date,
): Promise<string> {
  return await consumeSingleUseToken(
    fixture().handle.db,
    { purpose, token },
    async (tx, subjectId) => {
      await insertMarker(tx, subjectId, 'consumed');
      return subjectId;
    },
    now === undefined ? undefined : { now },
  );
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (error: unknown) => error,
  );
}

describe('issuing and consuming a single-use token (AUTH-03, AUTH-11)', () => {
  it('consumes a token once, authorises its subject and removes the row', async () => {
    const { subjectA } = fixture();
    const issuedAt = new Date('2026-09-14T09:00:00.000Z');
    const token = await issue(subjectA, 'set-password', () => issuedAt);

    const stored = await tokensFor(subjectA, 'set-password');
    expect(stored).toEqual([
      {
        identifier: digestIdentifier('set-password', token),
        value: subjectA,
        expiresAtMs: issuedAt.getTime() + 172800000,
      },
    ]);

    const authorised = await consumeRecording(
      token,
      'set-password',
      () => issuedAt,
    );

    expect(authorised).toBe(subjectA);
    expect(await tokensFor(subjectA, 'set-password')).toEqual([]);
    const markers = await fixture().handle.sql<{ subjectId: string }[]>`
      SELECT subject_id AS "subjectId" FROM consumption_marker
    `;
    expect(markers.map((row) => row.subjectId)).toEqual([subjectA]);
  });

  it('stores only a digest of the token, so a database read cannot replay the link', async () => {
    const { handle, subjectA } = fixture();
    const token = await issue(subjectA);

    const [dump] = await handle.sql<{ everything: string }[]>`
      SELECT string_agg(verification::text, ' ') AS everything FROM verification
    `;
    expect(dump?.everything).toContain(subjectA);
    expect(dump?.everything).not.toContain(token);

    const storedIdentifier = digestIdentifier('set-password', token);
    const error = await rejectionOf(
      consumeRecording(storedIdentifier.slice('set-password:'.length)),
    );
    expect(error).toBeInstanceOf(InvalidOrExpiredTokenError);
    expect(await tokensFor(subjectA, 'set-password')).toHaveLength(1);
  });

  it('lets exactly one of two concurrent consumptions authorise (AUTH-11)', async () => {
    const { handle, subjectA } = fixture();
    const token = await issue(subjectA);

    const attempt = (label: string): Promise<string> =>
      consumeSingleUseToken(
        handle.db,
        { purpose: 'set-password', token },
        async (tx, subjectId) => {
          await insertMarker(tx, subjectId, label);
          // Hold the transaction open so the other attempt overlaps it.
          await sleep(50);
          return label;
        },
      );

    const results = await Promise.allSettled([
      attempt('first'),
      attempt('second'),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(InvalidOrExpiredTokenError);
    expect(await markerCount()).toBe(1);
    expect(await tokensFor(subjectA, 'set-password')).toEqual([]);
  });

  it('keeps the token valid when the authorised action fails, and propagates its error (AUTH-11)', async () => {
    const { handle, subjectA } = fixture();
    const consoleSpies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ];
    const token = await issue(subjectA);
    const failure = new Error('the credential write failed');

    const error = await rejectionOf(
      consumeSingleUseToken(
        handle.db,
        { purpose: 'set-password', token },
        async (tx, subjectId) => {
          await insertMarker(tx, subjectId, 'rolled back');
          throw failure;
        },
      ),
    );

    expect(error).toBe(failure);
    expect(await markerCount()).toBe(0);
    expect(await tokensFor(subjectA, 'set-password')).toHaveLength(1);
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
    }

    expect(await consumeRecording(token)).toBe(subjectA);
    expect(await markerCount()).toBe(1);
  });

  it('rejects a consumed token exactly as it rejects one that was never issued (AUTH-03, T-02-35)', async () => {
    const { subjectA } = fixture();
    const token = await issue(subjectA);
    await consumeRecording(token);

    const replayed = await rejectionOf(consumeRecording(token));
    const neverIssued = await rejectionOf(
      consumeRecording(generateTokenValue()),
    );

    expect(replayed).toBeInstanceOf(InvalidOrExpiredTokenError);
    expect(neverIssued).toBeInstanceOf(InvalidOrExpiredTokenError);
    const shape = (error: unknown) => ({
      constructor: (error as object).constructor,
      name: (error as Error).name,
      message: (error as Error).message,
      purpose: (error as InvalidOrExpiredTokenError).purpose,
      keys: Object.keys(error as object).toSorted(),
    });
    expect(shape(replayed)).toEqual(shape(neverIssued));
    expect((replayed as Error).message).not.toContain(token);
    expect((replayed as Error).message).not.toContain(subjectA);
    expect(await markerCount()).toBe(1);
  });

  it('refuses a token at the exact expiry instant and accepts one a millisecond earlier (AUTH-03)', async () => {
    const { subjectA } = fixture();
    const expiry = new Date('2026-09-16T12:00:00.000Z');
    const issuedAt = new Date(expiry.getTime() - TTL * 1000);

    const atBoundary = await issue(subjectA, 'set-password', () => issuedAt);
    expect((await tokensFor(subjectA, 'set-password'))[0]?.expiresAtMs).toBe(
      expiry.getTime(),
    );

    const error = await rejectionOf(
      consumeRecording(
        atBoundary,
        'set-password',
        () => new Date(expiry.getTime()),
      ),
    );
    expect(error).toBeInstanceOf(InvalidOrExpiredTokenError);
    // The rejection rolled the delete back: the expired row was not swept.
    expect(await tokensFor(subjectA, 'set-password')).toHaveLength(1);
    expect(await markerCount()).toBe(0);

    const justBefore = await issue(subjectA, 'set-password', () => issuedAt);
    expect(
      await consumeRecording(
        justBefore,
        'set-password',
        () => new Date(expiry.getTime() - 1),
      ),
    ).toBe(subjectA);
    expect(await markerCount()).toBe(1);
  });

  it('lets two tabs spending one link change the entity once, not twice (AUTH-03)', async () => {
    const { handle, subjectA } = fixture();
    const token = await issue(subjectA);

    const tab = (label: string): Promise<string> =>
      consumeSingleUseToken(
        handle.db,
        { purpose: 'set-password', token },
        async (tx, subjectId) => {
          await sleep(50);
          await tx.execute(
            sql`UPDATE "user" SET name = name || ${` +${label}`} WHERE id = ${subjectId}`,
          );
          return label;
        },
      );

    const results = await Promise.allSettled([tab('tab-1'), tab('tab-2')]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const [row] = await handle.sql<{ name: string }[]>`
      SELECT name FROM "user" WHERE id = ${subjectA}
    `;
    expect(row?.name).toMatch(/^Alpha \+tab-[12]$/);
  });
});

describe('only the latest link is valid (D-09)', () => {
  it('deletes the earlier outstanding token when a new one is issued', async () => {
    const { subjectA } = fixture();
    const first = await issue(subjectA);
    const second = await issue(subjectA);

    expect(await tokensFor(subjectA, 'set-password')).toEqual([
      expect.objectContaining({
        identifier: digestIdentifier('set-password', second),
      }),
    ]);
    expect(await rejectionOf(consumeRecording(first))).toBeInstanceOf(
      InvalidOrExpiredTokenError,
    );
    expect(await consumeRecording(second)).toBe(subjectA);
  });

  it('keeps one outstanding token when two issues for one subject overlap', async () => {
    const { handle, subjectA } = fixture();
    let releaseFirst: () => void = () => undefined;
    const firstMayCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstIssued: () => void = () => undefined;
    const firstHasIssued = new Promise<void>((resolve) => {
      firstIssued = resolve;
    });

    const first = handle.db.transaction(async (tx) => {
      const issued = await issueSingleUseToken(tx, {
        subjectId: subjectA,
        purpose: 'set-password',
        ttlSeconds: TTL,
      });
      firstIssued();
      await firstMayCommit;
      return issued.token;
    });
    await firstHasIssued;

    // Issued later, through a plain database handle, while the first issue
    // is still uncommitted.
    const second = issueSingleUseToken(handle.db, {
      subjectId: subjectA,
      purpose: 'set-password',
      ttlSeconds: TTL,
    }).then((issued) => issued.token);
    await sleep(200);
    releaseFirst();

    const [firstToken, secondToken] = await Promise.all([first, second]);

    expect(await tokensFor(subjectA, 'set-password')).toEqual([
      expect.objectContaining({
        identifier: digestIdentifier('set-password', secondToken),
      }),
    ]);
    expect(await rejectionOf(consumeRecording(firstToken))).toBeInstanceOf(
      InvalidOrExpiredTokenError,
    );
    expect(await consumeRecording(secondToken)).toBe(subjectA);
  });

  it('never invalidates another subject’s token of the same purpose', async () => {
    const { subjectA, subjectB } = fixture();
    const tokenB = await issue(subjectB);
    await issue(subjectA);
    await issue(subjectA);

    expect(await tokensFor(subjectB, 'set-password')).toEqual([
      expect.objectContaining({
        identifier: digestIdentifier('set-password', tokenB),
      }),
    ]);
    expect(await consumeRecording(tokenB)).toBe(subjectB);
  });

  it('keeps set-password and reset-password tokens in separate namespaces', async () => {
    const { subjectA } = fixture();
    const setToken = await issue(subjectA, 'set-password');
    const resetToken = await issue(subjectA, 'reset-password');

    expect(await tokensFor(subjectA, 'set-password')).toHaveLength(1);
    expect(await tokensFor(subjectA, 'reset-password')).toHaveLength(1);

    expect(
      await rejectionOf(consumeRecording(setToken, 'reset-password')),
    ).toBeInstanceOf(InvalidOrExpiredTokenError);
    expect(await consumeRecording(resetToken, 'reset-password')).toBe(subjectA);
    expect(await consumeRecording(setToken, 'set-password')).toBe(subjectA);
  });
});

describe('invalid arguments (T-02-37)', () => {
  it('throws before any statement for an unknown purpose, an empty subject or a bad lifetime', async () => {
    const { handle, subjectA } = fixture();
    const attempts: [unknown, new (...args: never[]) => Error][] = [
      [{ subjectId: subjectA, purpose: 'admin', ttlSeconds: TTL }, TypeError],
      [{ subjectId: subjectA, purpose: '%', ttlSeconds: TTL }, TypeError],
      [{ subjectId: '', purpose: 'set-password', ttlSeconds: TTL }, TypeError],
      [
        { subjectId: subjectA, purpose: 'set-password', ttlSeconds: 0 },
        RangeError,
      ],
    ];

    for (const [input, errorClass] of attempts) {
      const error = await rejectionOf(
        Reflect.apply(issueSingleUseToken, undefined, [
          handle.db,
          input,
        ]) as Promise<unknown>,
      );
      expect(error).toBeInstanceOf(errorClass);
    }
    const [row] = await handle.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM verification
    `;
    expect(row?.count).toBe(0);
  });

  it('rejects an empty token as invalid and never runs the action', async () => {
    const { handle } = fixture();
    const authorize = vi.fn(async () => 'ran');

    expect(
      await rejectionOf(
        consumeSingleUseToken(
          handle.db,
          { purpose: 'magic-link', token: '' },
          authorize,
        ),
      ),
    ).toBeInstanceOf(InvalidOrExpiredTokenError);
    expect(
      await rejectionOf(
        Reflect.apply(consumeSingleUseToken, undefined, [
          handle.db,
          { purpose: 'unknown', token: generateTokenValue() },
          authorize,
        ]) as Promise<unknown>,
      ),
    ).toBeInstanceOf(TypeError);
    expect(authorize).not.toHaveBeenCalled();
  });
});
