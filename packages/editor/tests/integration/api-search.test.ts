/**
 * The page search route over a real database and auth instance: behind the
 * same gate as every editor route, scoped to a declared locale, and never
 * returning a trashed page.
 */
import { createPage, getPage, trashPage } from '@plakboek/pages';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiError, PageSearchResponse } from '../../src/api-types.js';
import { createEditorApi } from '../../src/server/api/handler.js';
import {
  apiRequest,
  components,
  createApiHarness,
  SITE_ORIGIN,
  type ApiHarness,
  type SignedIn,
} from './api-harness.js';

let harness: ApiHarness;
const ids: Record<string, string> = {};

beforeAll(async () => {
  harness = await createApiHarness();
  const { pagesDeps, actor } = harness;
  const create = async (
    key: string,
    locale: string,
    title: string,
  ): Promise<void> => {
    ids[key] = (await createPage(pagesDeps, actor, { locale, title })).id;
  };
  await create('team', 'en', 'Search team');
  await create('story', 'en', 'Search story');
  await create('dutch', 'nl', 'Search Nederlands');
  await create('gone', 'en', 'Search gone');
  const gone = await getPage(harness.handle.db, ids.gone!);
  await trashPage(pagesDeps, actor, {
    pageId: ids.gone!,
    baseVersion: gone?.version ?? 0,
  });
});

afterAll(async () => {
  await harness.close();
});

async function search(
  user: SignedIn | undefined,
  query: string,
): Promise<Response> {
  const api = createEditorApi({
    auth: harness.auth,
    resolver: harness.resolver,
    pages: harness.pagesDeps,
    homeSlug: 'home',
    components,
    siteOrigin: SITE_ORIGIN,
  });
  const response = await api.handle(
    apiRequest(`/cms/api/pages/search${query}`, { user }),
  );
  if (response === null) throw new Error('the API ignored the search');
  return response;
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as ApiError).error.code;
}

describe('GET /cms/api/pages/search', () => {
  it('refuses a request without a session', async () => {
    const response = await search(undefined, '?locale=en&q=search');
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('unauthenticated');
  });

  it('refuses a role that cannot edit pages', async () => {
    const response = await search(harness.viewer, '?locale=en&q=search');
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('forbidden');
  });

  it('refuses a locale the installation does not declare, and a query that is too long', async () => {
    const locale = await search(harness.editor, '?locale=de&q=search');
    expect(locale.status).toBe(400);
    expect(await errorCode(locale)).toBe('invalid-request');

    const long = await search(
      harness.editor,
      `?locale=en&q=${'x'.repeat(201)}`,
    );
    expect(long.status).toBe(400);

    const missing = await search(harness.editor, '?q=search');
    expect(missing.status).toBe(400);
  });

  it('gives an editor the pages of that locale with their addresses, never a trashed page', async () => {
    const response = await search(harness.editor, '?locale=en&q=search');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = (await response.json()) as PageSearchResponse;
    expect(body.ok).toBe(true);
    expect(body.results).toEqual([
      {
        id: ids.story,
        title: 'Search story',
        path: 'search-story',
        publicPath: '/search-story',
        live: false,
      },
      {
        id: ids.team,
        title: 'Search team',
        path: 'search-team',
        publicPath: '/search-team',
        live: false,
      },
    ]);
  });

  describe('with the id of one page', () => {
    async function lookup(
      user: SignedIn | undefined,
      key: string,
      locale = 'en',
    ): Promise<PageSearchResponse> {
      const response = await search(
        user,
        `?locale=${locale}&id=${ids[key] ?? ''}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      return (await response.json()) as PageSearchResponse;
    }

    it('answers that page alone, with its address', async () => {
      expect((await lookup(harness.editor, 'team')).results).toEqual([
        {
          id: ids.team,
          title: 'Search team',
          path: 'search-team',
          publicPath: '/search-team',
          live: false,
        },
      ]);
    });

    it('answers nothing for a trashed page', async () => {
      expect((await lookup(harness.editor, 'gone')).results).toEqual([]);
    });

    it('answers nothing for a page of another locale, and prefixes none for its own', async () => {
      expect((await lookup(harness.editor, 'dutch', 'en')).results).toEqual([]);
      expect(
        (await lookup(harness.editor, 'dutch', 'nl')).results.map(
          (result) => result.publicPath,
        ),
      ).toEqual(['/nl/search-nederlands']);
    });

    it('answers nothing for a page that never existed', async () => {
      const response = await search(
        harness.editor,
        '?locale=en&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      );
      expect(((await response.json()) as PageSearchResponse).results).toEqual(
        [],
      );
    });

    it('is behind the same gate, and refuses an id that is not a uuid', async () => {
      const anonymous = await search(
        undefined,
        `?locale=en&id=${ids.team ?? ''}`,
      );
      expect(anonymous.status).toBe(401);
      const viewer = await search(
        harness.viewer,
        `?locale=en&id=${ids.team ?? ''}`,
      );
      expect(viewer.status).toBe(403);
      const bad = await search(harness.editor, '?locale=en&id=team');
      expect(bad.status).toBe(400);
    });
  });

  it('prefixes the public path of a non-default locale', async () => {
    const response = await search(harness.editor, '?locale=nl');
    const body = (await response.json()) as PageSearchResponse;
    expect(body.results.map((result) => result.publicPath)).toEqual([
      '/nl/search-nederlands',
    ]);
  });
});
