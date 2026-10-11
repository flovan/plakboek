/**
 * Every `/cms` route module answers an error path, and a method it does not
 * serve, with `X-Robots-Tag` too. The runtime is replaced by one that throws,
 * which is what an invalid environment or a database failure looks like.
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

vi.mock('../../src/runtime/host.js', () => ({
  getHostRuntime: () => {
    throw new Error('DATABASE_URL=postgres://user:secret@db/plakboek');
  },
}));

const ROBOTS = 'noindex, nofollow';

const args = (method = 'GET') => ({
  request: new Request('http://localhost:3000/cms/x', { method }),
  params: {},
  context: {},
});

let write: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  write.mockRestore();
});

/** What a guarded error answer must be, read off the response. */
async function facts(response: Response): Promise<{
  status: number;
  robots: string | null;
  cache: string | null;
  body: string;
}> {
  return {
    status: response.status,
    robots: response.headers.get('X-Robots-Tag'),
    cache: response.headers.get('Cache-Control'),
    body: await response.text(),
  };
}

const GUARDED_500 = {
  status: 500,
  robots: ROBOTS,
  cache: 'no-store',
  body: 'Internal Server Error',
};

describe('a failing runtime under /cms', () => {
  it('is a headered 500 from the health loader', async () => {
    const { loader } = await import('../../src/route-modules/health.js');
    expect(await facts(await loader())).toEqual(GUARDED_500);
  });

  it('is a headered 500 from the setup loader and action', async () => {
    const { loader, action } = await import('../../src/route-modules/setup.js');
    expect(await facts(await loader(args() as never))).toEqual(GUARDED_500);
    expect(await facts(await action(args('POST') as never))).toEqual(
      GUARDED_500,
    );
  });

  it('is a headered 500 from the test-email loader and action', async () => {
    const { loader, action } =
      await import('../../src/route-modules/test-email.js');
    expect(await facts(await loader(args() as never))).toEqual(GUARDED_500);
    expect(await facts(await action(args('POST') as never))).toEqual(
      GUARDED_500,
    );
  });

  it('is a headered 500 from the /cms loader', async () => {
    const { loader } = await import('../../src/route-modules/cms.js');
    expect(await facts(await loader(args() as never))).toEqual(GUARDED_500);
  });
});

describe('a method health does not serve', () => {
  it('is a 405 that still says noindex', async () => {
    const { action } = await import('../../src/route-modules/health.js');
    const response = await action(args('POST') as never);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, HEAD');
    expect(response.headers.get('X-Robots-Tag')).toBe(ROBOTS);
  });
});
