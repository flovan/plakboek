/**
 * The editor API's edit route over a real database: one batch per request,
 * answered with the new model and the fragments of the sections it touched,
 * and every refusal under its documented status and code.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiError,
  EditOp,
  EditResponse,
  PreviewResponse,
  TreeResponse,
} from '../../src/api-types.js';
import { createEditorApi } from '../../src/server/api/handler.js';
import {
  apiRequest,
  components,
  createApiHarness,
  createColumnPage,
  SITE_ORIGIN,
  type ApiHarness,
  type SeededPage,
  type SignedIn,
} from './api-harness.js';

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(() => {
  harness.clock.reset();
});

function api(): ReturnType<typeof createEditorApi> {
  return createEditorApi({
    auth: harness.auth,
    resolver: harness.resolver,
    pages: harness.pagesDeps,
    homeSlug: 'home',
    components,
    siteOrigin: SITE_ORIGIN,
  });
}

async function post(
  user: SignedIn,
  path: string,
  body: unknown,
): Promise<Response> {
  const response = await api().handle(
    apiRequest(path, { user, method: 'POST', body }),
  );
  if (response === null) throw new Error(`the API ignored ${path}`);
  return response;
}

async function edit(
  user: SignedIn,
  pageId: string,
  body: {
    readonly basePageVersion: number;
    readonly ops: readonly (EditOp | Record<string, unknown>)[];
    readonly fragments?: boolean;
  },
): Promise<Response> {
  return await post(user, `/cms/api/pages/${pageId}/edit`, body);
}

async function readTree(user: SignedIn, pageId: string): Promise<TreeResponse> {
  const response = await api().handle(
    apiRequest(`/cms/api/pages/${pageId}/tree`, { user }),
  );
  return (await response?.json()) as TreeResponse;
}

async function readError(response: Response): Promise<ApiError['error']> {
  const body = (await response.json()) as ApiError;
  expect(body.ok).toBe(false);
  return body.error;
}

async function readEdit(response: Response): Promise<EditResponse> {
  expect(response.status).toBe(200);
  return (await response.json()) as EditResponse;
}

type TwoSections = {
  readonly seeded: SeededPage;
  readonly otherSectionId: string;
  readonly otherColumnId: string;
  readonly pageVersion: number;
};

/** A page with section A > column > heading and an empty section B > column. */
async function twoSectionPage(title: string): Promise<TwoSections> {
  const seeded = await createColumnPage(harness, { title, text: 'Hello' });
  const { pageVersion } = await readTree(harness.editor, seeded.pageId);
  const otherSectionId = randomUUID();
  const otherColumnId = randomUUID();
  const done = await readEdit(
    await edit(harness.editor, seeded.pageId, {
      basePageVersion: pageVersion,
      ops: [
        {
          op: 'insert',
          position: { parentId: null, previousId: seeded.sectionId },
          node: {
            id: otherSectionId,
            type: 'section',
            children: [{ id: otherColumnId, type: 'column' }],
          },
        },
      ],
    }),
  );
  return {
    seeded,
    otherSectionId,
    otherColumnId,
    pageVersion: done.pageVersion,
  };
}

describe('the edit route', () => {
  it('moves a heading across sections, answers the new model and both sections, and persists', async () => {
    const page = await twoSectionPage('Move across');
    const { seeded } = page;
    const tree = await readTree(harness.editor, seeded.pageId);
    const heading = tree.tree.find((node) => node.id === seeded.headingId);

    const response = await edit(harness.editor, seeded.pageId, {
      basePageVersion: page.pageVersion,
      ops: [
        {
          op: 'move',
          blockId: seeded.headingId,
          baseVersion: heading?.version ?? 1,
          position: { parentId: page.otherColumnId },
        },
      ],
    });
    const done = await readEdit(response);

    expect(done.pageVersion).toBe(page.pageVersion + 1);
    expect(
      done.tree.find((node) => node.id === seeded.headingId)?.parentId,
    ).toBe(page.otherColumnId);
    expect(done.createdIds).toEqual([]);
    expect(done.deletedIds).toEqual([]);
    const fragments = done.patch?.fragments ?? [];
    expect(fragments.map((fragment) => fragment.id)).toEqual([
      seeded.sectionId,
      page.otherSectionId,
    ]);
    expect(fragments[0]?.html).not.toContain('Hello');
    expect(fragments[1]?.html).toContain('Hello');
    expect(done.patch?.removed).toEqual([]);
    expect(done.patch?.rootOrder).toBeNull();

    const stored = await readTree(harness.editor, seeded.pageId);
    expect(stored.pageVersion).toBe(done.pageVersion);
    expect(
      stored.tree.find((node) => node.id === seeded.headingId)?.parentId,
    ).toBe(page.otherColumnId);
  });

  it('patches only the updated block for a property update', async () => {
    const page = await twoSectionPage('Update only');
    const { seeded } = page;
    const tree = await readTree(harness.editor, seeded.pageId);
    const heading = tree.tree.find((node) => node.id === seeded.headingId);
    const done = await readEdit(
      await edit(harness.editor, seeded.pageId, {
        basePageVersion: page.pageVersion,
        ops: [
          {
            op: 'update',
            blockId: seeded.headingId,
            baseVersion: heading?.version ?? 1,
            props: { text: 'Changed' },
          },
        ],
      }),
    );
    expect(done.patch?.fragments.map((fragment) => fragment.id)).toEqual([
      seeded.headingId,
    ]);
    expect(done.patch?.fragments[0]?.html).toContain('Changed');
  });

  it('answers no patch when fragments are not asked for', async () => {
    const page = await twoSectionPage('No fragments');
    const tree = await readTree(harness.editor, page.seeded.pageId);
    const heading = tree.tree.find((node) => node.id === page.seeded.headingId);
    const done = await readEdit(
      await edit(harness.editor, page.seeded.pageId, {
        basePageVersion: page.pageVersion,
        fragments: false,
        ops: [
          {
            op: 'update',
            blockId: page.seeded.headingId,
            baseVersion: heading?.version ?? 1,
            props: { text: 'Quiet' },
          },
        ],
      }),
    );
    expect(done.patch).toBeNull();
    expect(done.pageVersion).toBe(page.pageVersion + 1);
  });

  it('refuses a stale page version with 409 and writes nothing', async () => {
    const page = await twoSectionPage('Stale');
    const tree = await readTree(harness.editor, page.seeded.pageId);
    const heading = tree.tree.find((node) => node.id === page.seeded.headingId);
    const response = await edit(harness.editor, page.seeded.pageId, {
      basePageVersion: page.pageVersion - 1,
      ops: [
        {
          op: 'update',
          blockId: page.seeded.headingId,
          baseVersion: heading?.version ?? 1,
          props: { text: 'Nope' },
        },
      ],
    });
    expect(response.status).toBe(409);
    expect((await readError(response)).code).toBe('stale-page');
    const stored = await readTree(harness.editor, page.seeded.pageId);
    expect(stored.pageVersion).toBe(page.pageVersion);
    expect(
      stored.tree.find((node) => node.id === page.seeded.headingId)?.props,
    ).toEqual({ text: 'Hello' });
  });

  it('answers 404 for a block that belongs to another page', async () => {
    const mine = await twoSectionPage('Mine');
    const theirs = await createColumnPage(harness, {
      title: 'Theirs',
      text: 'Other',
    });
    const response = await edit(harness.editor, mine.seeded.pageId, {
      basePageVersion: mine.pageVersion,
      ops: [
        {
          op: 'update',
          blockId: theirs.headingId,
          baseVersion: 1,
          props: { text: 'Hijack' },
        },
      ],
    });
    expect(response.status).toBe(404);
    expect((await readError(response)).code).toBe('not-found');
  });

  it('refuses a delete without pages:delete with 403 and a denied audit row', async () => {
    const page = await twoSectionPage('Delete denied');
    const tree = await readTree(harness.limited, page.seeded.pageId);
    const heading = tree.tree.find((node) => node.id === page.seeded.headingId);
    const response = await edit(harness.limited, page.seeded.pageId, {
      basePageVersion: page.pageVersion,
      ops: [
        {
          op: 'delete',
          blockId: page.seeded.headingId,
          baseVersion: heading?.version ?? 1,
        },
      ],
    });
    expect(response.status).toBe(403);
    expect((await readError(response)).code).toBe('forbidden');
    const [row] = await harness.handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log
      WHERE action = 'block.edit' AND entity_id = ${page.seeded.pageId}
        AND outcome = 'denied'
    `;
    expect(Number(row?.count)).toBe(1);
  });

  it('refuses an illegal placement with 422', async () => {
    const page = await twoSectionPage('Placement');
    const tree = await readTree(harness.editor, page.seeded.pageId);
    const heading = tree.tree.find((node) => node.id === page.seeded.headingId);
    const response = await edit(harness.editor, page.seeded.pageId, {
      basePageVersion: page.pageVersion,
      ops: [
        {
          op: 'move',
          blockId: page.seeded.headingId,
          baseVersion: heading?.version ?? 1,
          position: { parentId: null },
        },
      ],
    });
    expect(response.status).toBe(422);
    expect((await readError(response)).code).toBe('placement');
  });

  it('refuses more operations than a batch may hold with 400', async () => {
    const page = await twoSectionPage('Too many');
    const op = {
      op: 'update',
      blockId: page.seeded.headingId,
      baseVersion: 1,
      props: { text: 'x' },
    };
    const response = await edit(harness.editor, page.seeded.pageId, {
      basePageVersion: page.pageVersion,
      ops: Array.from({ length: 51 }, () => op),
    });
    expect(response.status).toBe(400);
    const error = await readError(response);
    expect(error.code).toBe('invalid-request');
    expect(error.issues?.some((issue) => issue.key === 'ops')).toBe(true);
  });

  it('answers 404 for a page that does not exist', async () => {
    const response = await edit(harness.editor, randomUUID(), {
      basePageVersion: 1,
      ops: [{ op: 'delete', blockId: randomUUID(), baseVersion: 1 }],
    });
    expect(response.status).toBe(404);
  });
});

describe('the preview route', () => {
  async function preview(
    user: SignedIn,
    pageId: string,
    body: unknown,
  ): Promise<Response> {
    return await post(user, `/cms/api/pages/${pageId}/preview`, body);
  }

  async function readPreview(response: Response): Promise<PreviewResponse> {
    expect(response.status).toBe(200);
    return (await response.json()) as PreviewResponse;
  }

  it('renders candidate values without writing anything', async () => {
    const page = await twoSectionPage('Preview');
    const before = await readTree(harness.editor, page.seeded.pageId);
    const answer = await readPreview(
      await preview(harness.editor, page.seeded.pageId, {
        blockId: page.seeded.headingId,
        props: { text: 'Candidate heading' },
      }),
    );
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.html).toContain('Candidate heading');
    expect(answer.needsInput).toEqual([]);

    const after = await readTree(harness.editor, page.seeded.pageId);
    expect(after.pageVersion).toBe(before.pageVersion);
    expect(
      after.tree.find((node) => node.id === page.seeded.headingId),
    ).toEqual(before.tree.find((node) => node.id === page.seeded.headingId));
  });

  it('reports a required property that is still empty', async () => {
    const page = await twoSectionPage('Needs input');
    const answer = await readPreview(
      await preview(harness.editor, page.seeded.pageId, {
        blockId: page.seeded.headingId,
        props: { text: '' },
      }),
    );
    expect(answer).toMatchObject({ ok: true, needsInput: ['text'] });
  });

  it('refuses a value of the wrong type with the key and code only', async () => {
    const page = await twoSectionPage('Invalid');
    const response = await preview(harness.editor, page.seeded.pageId, {
      blockId: page.seeded.headingId,
      props: { text: 12345 },
    });
    const answer = await readPreview(response);
    expect(answer).toEqual({
      ok: false,
      issues: [{ key: 'text', code: 'INVALID' }],
    });
  });

  it('answers 404 for a block of another page', async () => {
    const mine = await twoSectionPage('Preview mine');
    const theirs = await createColumnPage(harness, {
      title: 'Preview theirs',
      text: 'Other',
    });
    const response = await preview(harness.editor, mine.seeded.pageId, {
      blockId: theirs.headingId,
    });
    expect(response.status).toBe(404);
  });

  it('is refused for a viewer', async () => {
    const page = await twoSectionPage('Preview viewer');
    const response = await preview(harness.viewer, page.seeded.pageId, {
      blockId: page.seeded.headingId,
    });
    expect(response.status).toBe(403);
  });
});
