/**
 * The route table through real builds: the CMS serves `/` and unclaimed
 * paths, a host route listed first always wins (including a host index route
 * in a second build), the health route answers and the `_edit` seam reaches the
 * entrypoint the plugin wired in.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createPage, getPage, insertBlock, publishPage } from '@plakboek/pages';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_CLIENT_DIR,
  FIXTURE_HOST_INDEX_BUILD_DIR,
  FIXTURE_SERVER_ENTRY,
  buildFixtureHost,
} from './fixture-host.js';
import { createInstallation, type Installation } from './installation.js';

type Served = { url: (path: string) => string };

describe('the CMS route table inside a host app', () => {
  let installation: Installation;
  let defaultBuild: Served;
  let hostIndexBuild: Served;

  async function publishAboutPage(): Promise<void> {
    const { runtime, actor } = installation;
    const page = await createPage(runtime.pages, actor, {
      locale: 'en',
      title: 'About',
      slug: 'about-cms-page',
    });
    const owner = {
      ownerType: 'page' as const,
      ownerId: page.id,
      locale: page.locale,
    };
    const version = async (): Promise<number> =>
      (await getPage(runtime.pages.db, page.id))?.version ?? -1;
    const section = await insertBlock(runtime.pages, actor, {
      owner,
      blockType: 'section',
      parentBlockId: null,
      basePageVersion: await version(),
    });
    await insertBlock(runtime.pages, actor, {
      owner,
      blockType: 'heading',
      parentBlockId: section.id,
      props: { text: 'About the CMS' },
      basePageVersion: await version(),
    });
    await publishPage(runtime.pages, actor, {
      pageId: page.id,
      baseVersion: await version(),
    });
  }

  beforeAll(async () => {
    buildFixtureHost({
      FIXTURE_BUILD_DIR: 'build-host-index',
      FIXTURE_HOST_INDEX: '1',
    });
    installation = await createInstallation();
    await publishAboutPage();
    defaultBuild = await installation.serve({
      serverEntry: FIXTURE_SERVER_ENTRY,
      clientDir: FIXTURE_CLIENT_DIR,
    });
    hostIndexBuild = await installation.serve({
      serverEntry: join(FIXTURE_HOST_INDEX_BUILD_DIR, 'server', 'index.js'),
      clientDir: join(FIXTURE_HOST_INDEX_BUILD_DIR, 'client'),
    });
  });

  afterAll(async () => {
    await installation?.dispose();
  });

  describe('default build', () => {
    it('serves the CMS home page at /', async () => {
      const response = await fetch(defaultBuild.url('/'));
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('Hello world');
      expect(body).not.toContain('Host home');
    });

    it('serves a host route next to the CMS', async () => {
      const response = await fetch(defaultBuild.url('/hello'));
      expect(await response.text()).toContain('Hello from the host route');
    });

    it('serves a published CMS page through the splat', async () => {
      const response = await fetch(defaultBuild.url('/about-cms-page'));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('About the CMS');
    });

    it('answers /cms/health with 200 JSON, uncacheable', async () => {
      const response = await fetch(defaultBuild.url('/cms/health'));
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain(
        'application/json',
      );
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({ status: 'ok' });
    });
  });

  describe('the _edit seam', () => {
    it('reaches the entrypoint the plugin wired in, uncacheable', async () => {
      const response = await fetch(defaultBuild.url('/?_edit=1'), {
        redirect: 'manual',
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('edit seam reached');
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('keeps the entrypoint out of every client asset', () => {
      const assets = join(FIXTURE_CLIENT_DIR, 'assets');
      for (const name of readdirSync(assets)) {
        expect(readFileSync(join(assets, name), 'utf8')).not.toContain(
          'edit seam reached',
        );
      }
    });

    it('leaves the plain visitor page free of editor content', async () => {
      const response = await fetch(defaultBuild.url('/'));
      const body = await response.text();
      expect(body).toContain('Hello world');
      expect(body).not.toContain('edit seam reached');
    });

    it('bounces every _edit request when no entrypoint is wired in', async () => {
      // The installation's own runtime is built from the configuration alone.
      const response = await installation.runtime.visitor(
        new Request('http://localhost:3000/about-cms-page?_edit=1'),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('/about-cms-page');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    });
  });

  describe('host index build', () => {
    it('lets the host index route win /', async () => {
      const response = await fetch(hostIndexBuild.url('/'));
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('Host home');
      expect(body).not.toContain('Hello world');
    });

    it('still serves a published CMS page from the CMS', async () => {
      const response = await fetch(hostIndexBuild.url('/about-cms-page'));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('About the CMS');
    });

    it('still serves the host route and the health route', async () => {
      const hello = await fetch(hostIndexBuild.url('/hello'));
      expect(await hello.text()).toContain('Hello from the host route');
      const health = await fetch(hostIndexBuild.url('/cms/health'));
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok' });
    });
  });
});
