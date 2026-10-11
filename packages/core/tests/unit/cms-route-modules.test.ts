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

async function expectGuarded500(response: Response): Promise<void> {
  expect(response.status).toBe(500);
  expect(response.headers.get('X-Robots-Tag')).toBe(ROBOTS);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.text()).toBe('Internal Server Error');
}

describe('a failing runtime under /cms', () => {
  it('is a headered 500 from the health loader', async () => {
    const { loader } = await import('../../src/route-modules/health.js');
    await expectGuarded500(await loader());
  });

  it('is a headered 500 from the setup loader and action', async () => {
    const { loader, action } = await import('../../src/route-modules/setup.js');
    await expectGuarded500(await loader(args() as never));
    await expectGuarded500(await action(args('POST') as never));
  });

  it('is a headered 500 from the test-email loader and action', async () => {
    const { loader, action } =
      await import('../../src/route-modules/test-email.js');
    await expectGuarded500(await loader(args() as never));
    await expectGuarded500(await action(args('POST') as never));
  });

  it('is a headered 500 from the /cms loader', async () => {
    const { loader } = await import('../../src/route-modules/cms.js');
    await expectGuarded500(await loader(args() as never));
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
