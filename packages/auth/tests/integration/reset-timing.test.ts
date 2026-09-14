import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import { defaultRoles, defineRoles } from '@plakboek/permissions';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuth, type Auth } from '../../src/config.js';
import {
  completeSetPassword,
  requestPasswordLink,
  type PasswordLinkProbe,
} from '../../src/credentials.js';
import type { MailMessage, MailSender } from '../../src/email/types.js';
import { createUserWithRole } from '../../src/first-user.js';
import { InvalidOrExpiredTokenError } from '../../src/tokens.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const BASE_URL = 'http://localhost:3000';
const SECRET = 'reset-timing-test-secret-with-at-least-32-characters';
const KNOWN_EMAIL = 'editor@example.com';
const UNKNOWN_EMAIL = 'nobody@example.com';
const LINK_PATTERN = /https?:\/\/\S+[?&]token=[\w-]+/;

/** Samples per path for the duration comparison. */
const SAMPLES = 40;
/** Warm-up runs per path before sampling: connection pool, JIT, caches. */
const WARM_UP = 5;
/** The slowest tenth of each path is dropped as scheduling noise. */
const DISCARDED_FRACTION = 0.1;
/** Deliberately loose: the medians must lie within this factor of each
 * other. The probe assertion is the deterministic one. */
const MEDIAN_RATIO_LIMIT = 3;

const roles = defineRoles(defaultRoles);

type RecordingSender = MailSender & { readonly sent: MailMessage[] };

type Fixture = {
  readonly testDatabase: TestDatabase;
  readonly handle: Db;
  readonly auth: Auth;
  readonly mail: RecordingSender;
  readonly knownUserId: string;
};

let current: Fixture | undefined;

function fixture(): Fixture {
  if (current === undefined) {
    throw new Error('the per-test database fixture is not set up');
  }
  return current;
}

function recordingSender(): RecordingSender {
  const sent: MailMessage[] = [];
  return {
    sent,
    send(message) {
      sent.push(message);
      return Promise.resolve();
    },
  };
}

beforeEach(async () => {
  const testDatabase = await createTestDatabase();
  try {
    const { connectionString } = testDatabase;
    await runMigrations({ connectionString });
    const handle = createDb({ connectionString });
    const mail = recordingSender();
    const auth = createAuth({
      db: handle.db,
      baseURL: BASE_URL,
      secret: SECRET,
      mail,
      roles,
    });
    await createUserWithRole(handle.db, {
      id: randomUUID(),
      email: 'owner@example.com',
      name: 'Owner',
      roleKey: 'editor',
    });
    const known = await createUserWithRole(handle.db, {
      id: randomUUID(),
      email: KNOWN_EMAIL,
      name: 'Editor',
      roleKey: 'editor',
    });
    current = { testDatabase, handle, auth, mail, knownUserId: known.userId };
  } catch (error) {
    await testDatabase.drop();
    throw error;
  }
});

afterEach(async () => {
  const finished = current;
  current = undefined;
  if (finished !== undefined) {
    await finished.handle.close();
    await finished.testDatabase.drop();
  }
});

function request(email: string, probe?: PasswordLinkProbe) {
  const { handle, mail } = fixture();
  return requestPasswordLink(
    {
      db: handle.db,
      mail,
      baseURL: BASE_URL,
      ...(probe === undefined ? {} : { probe }),
    },
    { email, purpose: 'reset-password' },
  );
}

function countingProbe() {
  const counts = { tokens: 0, verificationQueries: 0 };
  const probe: PasswordLinkProbe = {
    onTokenGenerated() {
      counts.tokens += 1;
    },
    onVerificationQuery() {
      counts.verificationQueries += 1;
    },
  };
  return { counts, probe };
}

async function countRows(
  query: Promise<readonly { count: number }[]>,
): Promise<number> {
  const [row] = await query;
  return row?.count ?? 0;
}

function tokenFrom(message: MailMessage | undefined): string {
  const link =
    message === undefined ? undefined : LINK_PATTERN.exec(message.text)?.[0];
  const token =
    link === undefined ? null : new URL(link).searchParams.get('token');
  if (token === null) {
    throw new Error('the link message carries no token');
  }
  return token;
}

/** The median of the fastest nine tenths of `durations`. */
function trimmedMedian(durations: readonly number[]): number {
  const kept = durations
    .toSorted((a, b) => a - b)
    .slice(0, Math.ceil(durations.length * (1 - DISCARDED_FRACTION)));
  const middle = Math.floor(kept.length / 2);
  return kept.length % 2 === 1
    ? (kept[middle] ?? 0)
    : ((kept[middle - 1] ?? 0) + (kept[middle] ?? 0)) / 2;
}

async function timed(run: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await run();
  return performance.now() - started;
}

describe('a reset request reveals nothing about whether the address is registered (AUTH-05)', () => {
  it('does the same counted work for a known and an unknown address', async () => {
    const known = countingProbe();
    const unknown = countingProbe();

    await request(KNOWN_EMAIL, known.probe);
    await request(UNKNOWN_EMAIL, unknown.probe);

    expect(known.counts).toEqual({ tokens: 1, verificationQueries: 1 });
    expect(unknown.counts).toEqual(known.counts);
  });

  it('leaves no verification row and sends nothing for an unknown address, and returns the identical outcome', async () => {
    const { handle, mail } = fixture();

    const unknownOutcome = await request(UNKNOWN_EMAIL);

    expect(
      await countRows(handle.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM verification
      `),
    ).toBe(0);
    expect(mail.sent).toEqual([]);

    const knownOutcome = await request(KNOWN_EMAIL);

    expect(unknownOutcome).toStrictEqual(knownOutcome);
    expect(unknownOutcome).toStrictEqual({ delivered: true });
    expect(mail.sent).toHaveLength(1);
    expect(
      await countRows(handle.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM verification
      `),
    ).toBe(1);
  });

  it('keeps the durations of the two paths in one band', async () => {
    for (let run = 0; run < WARM_UP; run += 1) {
      await request(KNOWN_EMAIL);
      await request(UNKNOWN_EMAIL);
    }

    const knownDurations: number[] = [];
    const unknownDurations: number[] = [];
    // Interleaved, so drift in the machine's load affects both paths alike.
    for (let run = 0; run < SAMPLES; run += 1) {
      knownDurations.push(await timed(() => request(KNOWN_EMAIL)));
      unknownDurations.push(await timed(() => request(UNKNOWN_EMAIL)));
    }

    // An approximate check, secondary to the probe assertion above: a
    // wall-clock comparison on a shared machine is noisy, so it only
    // requires the two trimmed medians to lie within a generous factor of
    // each other, not to be equal.
    const knownMedian = trimmedMedian(knownDurations);
    const unknownMedian = trimmedMedian(unknownDurations);
    const ratio =
      Math.max(knownMedian, unknownMedian) /
      Math.min(knownMedian, unknownMedian);
    expect(ratio).toBeLessThan(MEDIAN_RATIO_LIMIT);
  });

  it('leaves exactly one valid reset link after two concurrent requests (D-09)', async () => {
    const { handle, auth, mail, knownUserId } = fixture();

    await Promise.all([request(KNOWN_EMAIL), request(KNOWN_EMAIL)]);

    expect(
      await countRows(handle.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM verification
        WHERE value = ${knownUserId} AND identifier LIKE 'reset-password:%'
      `),
    ).toBe(1);
    expect(mail.sent).toHaveLength(2);

    const tokens = mail.sent.map((message) => tokenFrom(message));
    const outcomes = [];
    for (const token of tokens) {
      outcomes.push(
        await completeSetPassword(
          { db: handle.db, auth },
          {
            purpose: 'reset-password',
            token,
            newPassword: 'a much newer passphrase',
          },
        ).then(
          (result) => ({ fulfilled: result }),
          (error: unknown) => ({ rejected: error }),
        ),
      );
    }
    expect(outcomes.filter((outcome) => 'fulfilled' in outcome)).toEqual([
      { fulfilled: { userId: knownUserId } },
    ]);
    const rejected = outcomes.flatMap((outcome) =>
      'rejected' in outcome ? [outcome.rejected] : [],
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(InvalidOrExpiredTokenError);
  });
});
