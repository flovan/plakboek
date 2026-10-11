/**
 * The logout action against a stand-in auth, for the answers a real database
 * cannot be made to give: a sign-out that fails must not look like one that
 * worked.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

const signOut = vi.fn();

vi.mock('../../src/runtime/host.js', () => ({
  getHostRuntime: () => ({
    env: { siteUrl: 'http://localhost:3000' },
    auth: { api: { signOut } },
  }),
}));

const { action } = await import('../../src/route-modules/cms-logout.js');

function post(): Parameters<typeof action>[0] {
  return {
    request: new Request('http://localhost:3000/cms/logout', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:3000',
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: 'session_token=abc',
      },
      body: 'next=%2Fabout',
    }),
    params: {},
    context: {},
  } as never;
}

function answer(status: number, cookies: string[] = []): Response {
  const headers = new Headers();
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status, headers });
}

let write: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  signOut.mockReset();
  write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  write.mockRestore();
});

describe('logout when the sign-out succeeds', () => {
  it('redirects with the cleared cookie', async () => {
    signOut.mockResolvedValue(answer(200, ['session_token=; Max-Age=0']));
    const response = await action(post());
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/about');
    expect(response.headers.getSetCookie()).toEqual([
      'session_token=; Max-Age=0',
    ]);
  });

  it.each([400, 401])(
    'still redirects when there was no session to end (%i)',
    async (status) => {
      signOut.mockResolvedValue(answer(status, ['session_token=; Max-Age=0']));
      const response = await action(post());
      expect(response.status).toBe(303);
      expect(response.headers.getSetCookie()).toHaveLength(1);
    },
  );
});

describe('logout when the sign-out fails', () => {
  it.each([429, 500, 503])(
    'does not report success for a %i answer, and keeps the cookie it cleared',
    async (status) => {
      signOut.mockResolvedValue(answer(status, ['session_token=; Max-Age=0']));
      const response = await action(post());
      expect(response.status).toBe(500);
      expect(response.headers.get('Location')).toBeNull();
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.getSetCookie()).toEqual([
        'session_token=; Max-Age=0',
      ]);
      expect(String(write.mock.calls[0]?.[0])).toContain(
        `logout failed: status ${String(status)}`,
      );
    },
  );

  it('does not report success when the sign-out throws, and logs only the error name', async () => {
    signOut.mockRejectedValue(new Error('connect ECONNREFUSED db:5432'));
    const response = await action(post());
    expect(response.status).toBe(500);
    expect(response.headers.get('Location')).toBeNull();
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    const logged = write.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(logged).toContain('logout failed: Error');
    expect(logged).not.toContain('ECONNREFUSED');
  });
});
