/**
 * better-auth mounted at /api/auth through the built fixture app: its own
 * routes answer, and the package's closed routes stay closed (D-19).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_CLIENT_DIR, FIXTURE_SERVER_ENTRY } from './fixture-host.js';
import {
  createEmptyInstallation,
  type EmptyInstallation,
} from './installation.js';

describe('the better-auth mount', () => {
  let installation: EmptyInstallation;
  let url: (path: string) => string;

  beforeAll(async () => {
    installation = await createEmptyInstallation();
    ({ url } = await installation.serve({
      serverEntry: FIXTURE_SERVER_ENTRY,
      clientDir: FIXTURE_CLIENT_DIR,
    }));
  });

  afterAll(async () => {
    await installation?.dispose();
  });

  it('answers better-auth own health route', async () => {
    const response = await fetch(url('/api/auth/ok'));
    expect(response.status).toBe(200);
  });

  it('keeps public sign-up closed through the mount', async () => {
    const response = await fetch(url('/api/auth/sign-up/email'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
      },
      body: JSON.stringify({
        name: 'Mallory',
        email: 'mallory@example.com',
        password: 'correct horse battery staple',
      }),
    });
    expect(response.status).toBe(404);
  });
});
