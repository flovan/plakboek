import { ContentConfigError, getFieldTypeDefinition } from '@plakboek/content';
import {
  BlockConfigError,
  getBlockDefinition,
  listBlockDefinitions,
} from '@plakboek/pages';
import { RoleConfigError, defineRoles } from '@plakboek/permissions';
import { describe, expect, it } from 'vitest';
import {
  PlakboekConfigError,
  defaultRoles,
  defineConfig,
} from '../../src/config.js';
import { defineBlock } from '../../src/blocks.js';
import { defineModule } from '../../src/modules.js';
import type { PlakboekConfigInput, SeedPage } from '../../src/types.js';

const Render = () => null;

const section = defineBlock({
  key: 'section',
  kind: 'section',
  editor: { label: 'Section' },
  schemaVersion: 1,
  properties: {},
  component: Render,
});

const heading = defineBlock({
  key: 'heading',
  editor: { label: 'Heading' },
  schemaVersion: 1,
  properties: {
    text: { fieldType: 'short_text', label: 'Text', required: true },
  },
  component: Render,
});

const quote = defineBlock({
  key: 'quote',
  editor: { label: 'Quote' },
  schemaVersion: 1,
  properties: {
    body: { fieldType: 'short_text', label: 'Body', required: true },
  },
  component: Render,
});

const base = {
  siteName: 'Test site',
  locales: ['en', 'nl'],
  defaultLocale: 'en',
  timezone: 'Europe/Brussels',
  blocks: [section, heading],
} satisfies PlakboekConfigInput;

const issueCodes = (error: unknown): string[] =>
  error instanceof PlakboekConfigError
    ? error.issues.map((issue) => issue.code)
    : [];

function catchError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('defineConfig: composition', () => {
  it('registers a third block through config alone', () => {
    const config = defineConfig({ ...base, blocks: [section, heading, quote] });

    expect(Object.isFrozen(config)).toBe(true);
    expect(config.pages.blocks.map((block) => block.key).sort()).toEqual([
      'heading',
      'quote',
      'section',
    ]);
    expect(
      listBlockDefinitions()
        .map((block) => block.key)
        .sort(),
    ).toEqual(['heading', 'quote', 'section']);
  });

  it('keeps the content config, module names and the home slug', () => {
    const config = defineConfig({
      ...base,
      modules: [defineModule({ name: 'blog' }), defineModule({ name: 'shop' })],
    });
    expect(config.content.defaultLocale).toBe('en');
    expect(config.modules).toEqual(['blog', 'shop']);
    expect(config.homeSlug).toBe('home');
    expect(config.seed).toBeNull();
  });

  it('defaults roles to defaultRoles and re-exports it', () => {
    expect(defineConfig(base).roles).toEqual(defineRoles(defaultRoles));
  });

  it('propagates RoleConfigError for a role map without superadmin', () => {
    const error = catchError(() =>
      defineConfig({ ...base, roles: { editor: [] } as never }),
    );
    expect(error).toBeInstanceOf(RoleConfigError);
  });

  it('passes rules through to the pages config', () => {
    const config = defineConfig({
      ...base,
      sectionNestingDepth: 3,
      blockDepthCeiling: 9,
    });
    expect(config.pages.sectionNestingDepth).toBe(3);
    expect(config.pages.blockDepthCeiling).toBe(9);
  });

  it('freezes menus and keeps them readable', () => {
    const config = defineConfig({
      ...base,
      menus: { main: [{ label: 'Home', href: '/' }] },
    });
    expect(Object.isFrozen(config.menus)).toBe(true);
    expect(config.menus.main?.[0]?.href).toBe('/');
  });
});

describe('defineConfig: engine errors propagate unchanged', () => {
  it('lets ContentConfigError through for an invalid locale', () => {
    const error = catchError(() =>
      defineConfig({ ...base, locales: ['EN!'], defaultLocale: 'EN!' }),
    );
    expect(error).toBeInstanceOf(ContentConfigError);
    expect(error).not.toBeInstanceOf(PlakboekConfigError);
  });

  it('lets BlockConfigError through for an unknown field type', () => {
    const bad = defineBlock({
      key: 'bad',
      editor: { label: 'Bad' },
      schemaVersion: 1,
      properties: { x: { fieldType: 'no_such_type', label: 'X' } },
      component: Render,
    });
    const error = catchError(() =>
      defineConfig({ ...base, blocks: [section, bad] }),
    );
    expect(error).toBeInstanceOf(BlockConfigError);
    expect(error).not.toBeInstanceOf(PlakboekConfigError);
  });
});

describe('defineConfig: site name', () => {
  it.each([
    ['blank', '   '],
    ['empty', ''],
    ['too long', 'x'.repeat(201)],
    ['control character', 'Acme\u0007 Co'],
    ['newline', 'Acme\nCo'],
  ])('refuses a %s site name', (_label, siteName) => {
    const error = catchError(() => defineConfig({ ...base, siteName }));
    expect(error).toBeInstanceOf(PlakboekConfigError);
    expect(issueCodes(error)).toEqual(['INVALID_SITE_NAME']);
  });

  it('lists every bad field in one error before any engine call', () => {
    const error = catchError(() =>
      defineConfig({
        ...base,
        siteName: ' ',
        menus: { main: [{ label: '', href: '/' }] },
        modules: [defineModule({ name: 'Bad Name' })],
      }),
    );
    expect(error).toBeInstanceOf(PlakboekConfigError);
    expect(issueCodes(error).sort()).toEqual([
      'INVALID_MENU_ITEM',
      'INVALID_MODULE',
      'INVALID_SITE_NAME',
    ]);
    expect((error as Error).message).toContain(
      '[@plakboek/core] invalid config:',
    );
    expect((error as Error).message).toContain('menus.main[0]');
  });
});

describe('defineConfig: menus', () => {
  it('refuses a javascript: href and names the menu and item index', () => {
    const error = catchError(() =>
      defineConfig({
        ...base,
        menus: {
          main: [
            { label: 'Home', href: '/' },
            { label: 'Bad', href: 'javascript:alert(1)' },
          ],
        },
      }),
    );
    expect(issueCodes(error)).toEqual(['INVALID_MENU_ITEM']);
    expect((error as Error).message).toContain('menus.main[1]');
  });
});

describe('defineConfig: modules', () => {
  it('refuses two modules with the same name', () => {
    const error = catchError(() =>
      defineConfig({
        ...base,
        modules: [
          defineModule({ name: 'blog' }),
          defineModule({ name: 'blog' }),
        ],
      }),
    );
    expect(issueCodes(error)).toEqual(['DUPLICATE_MODULE']);
  });

  it('refuses a name that fails the module name pattern', () => {
    const error = catchError(() =>
      defineConfig({ ...base, modules: [defineModule({ name: '9blog' })] }),
    );
    expect(issueCodes(error)).toEqual(['INVALID_MODULE']);
  });

  it('merges module blocks before the host list and the host wins on a shared key', () => {
    const moduleCard = defineBlock({
      key: 'card',
      editor: { label: 'Module card' },
      schemaVersion: 1,
      properties: {},
      component: Render,
    });
    const hostCard = defineBlock({
      key: 'card',
      editor: { label: 'Host card' },
      schemaVersion: 1,
      properties: {},
      component: Render,
    });

    const config = defineConfig({
      ...base,
      blocks: [section, heading, hostCard],
      modules: [defineModule({ name: 'cards', blocks: [moduleCard] })],
    });

    const cards = config.pages.blocks.filter((block) => block.key === 'card');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.editor.label).toBe('Host card');
    expect(getBlockDefinition('card').editor.label).toBe('Host card');
  });

  it('adds a module-only block to the registry', () => {
    const config = defineConfig({
      ...base,
      modules: [defineModule({ name: 'quotes', blocks: [quote] })],
    });
    expect(config.pages.blocks.map((block) => block.key)).toContain('quote');
  });

  it('applies module constraints alongside the host constraints', () => {
    const config = defineConfig({
      ...base,
      blocks: [section, heading, quote],
      modules: [
        defineModule({
          name: 'quotes',
          constraints: [{ blockKey: 'quote', properties: { body: 'hidden' } }],
        }),
      ],
      constraints: [{ blockKey: 'heading', properties: { text: 'hidden' } }],
    });
    const byKey = new Map(config.pages.blocks.map((b) => [b.key, b]));
    expect(byKey.get('quote')?.constraints?.body).toEqual({ kind: 'hidden' });
    expect(byKey.get('heading')?.constraints?.text).toEqual({ kind: 'hidden' });
  });

  it('registers module field types before the host list so the host wins, and lets a block use them', () => {
    const shortText = getFieldTypeDefinition('short_text');
    const tagline = defineBlock({
      key: 'tagline',
      editor: { label: 'Tagline' },
      schemaVersion: 1,
      properties: { line: { fieldType: 'tagline_text', label: 'Line' } },
      component: Render,
    });

    const config = defineConfig({
      ...base,
      blocks: [section, tagline],
      modules: [
        defineModule({
          name: 'taglines',
          fieldTypes: [
            {
              ...shortText,
              fieldType: 'tagline_text',
              widgets: ['plain', 'fancy'],
              defaultWidget: 'plain',
            },
          ],
        }),
      ],
      fieldTypes: [
        {
          ...shortText,
          fieldType: 'tagline_text',
          widgets: ['fancy'],
          defaultWidget: 'fancy',
        },
      ],
    });

    expect(getFieldTypeDefinition('tagline_text').defaultWidget).toBe('fancy');
    const block = config.pages.blocks.find((b) => b.key === 'tagline');
    expect(block?.properties.line?.widget).toBe('fancy');
  });
});

describe('defineConfig: seed', () => {
  const seed = (blocks: SeedPage['blocks']): SeedPage => ({
    title: 'Home',
    blocks,
  });

  it('keeps a valid seed', () => {
    const page = seed([
      {
        type: 'section',
        children: [{ type: 'heading', props: { text: 'Hello' } }],
      },
    ]);
    expect(defineConfig({ ...base, seed: page }).seed).toEqual(page);
  });

  it('resolves a seed factory', () => {
    const page = seed([{ type: 'section' }]);
    expect(defineConfig({ ...base, seed: () => page }).seed).toEqual(page);
  });

  it('refuses a root block that is not a section', () => {
    const error = catchError(() =>
      defineConfig({
        ...base,
        seed: seed([{ type: 'heading', props: { text: 'Hi' } }]),
      }),
    );
    expect(issueCodes(error)).toEqual(['SEED_ROOT_NOT_SECTION']);
  });

  it('refuses a seed naming an unregistered block', () => {
    const error = catchError(() =>
      defineConfig({
        ...base,
        seed: seed([{ type: 'section', children: [{ type: 'nope' }] }]),
      }),
    );
    expect(issueCodes(error)).toEqual(['UNKNOWN_SEED_BLOCK']);
    expect((error as Error).message).toContain('nope');
  });

  it('refuses a malformed seed shape', () => {
    const error = catchError(() =>
      defineConfig({
        ...base,
        seed: { title: '', blocks: 'nope' } as never,
      }),
    );
    expect(issueCodes(error)).toContain('INVALID_SEED');
  });

  it('refuses a node without a string type or with non-object props', () => {
    const error = catchError(() =>
      defineConfig({
        ...base,
        seed: seed([
          { type: 3 as never },
          { type: 'section', props: [] as never },
        ]),
      }),
    );
    expect(issueCodes(error)).toEqual(['INVALID_SEED', 'INVALID_SEED']);
  });
});

describe('defineConfig: re-evaluation (dev reload)', () => {
  it('replaces the process-wide registry without throwing or duplicating', () => {
    const first = defineConfig({ ...base, blocks: [section, heading, quote] });
    const second = defineConfig({ ...base, blocks: [section, heading] });

    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
    expect(
      listBlockDefinitions()
        .map((block) => block.key)
        .sort(),
    ).toEqual(['heading', 'section']);
    expect(first.pages.blocks).toHaveLength(3);
    expect(second.pages.blocks).toHaveLength(2);
  });

  it('is a no-op in effect when evaluated twice with the same input', () => {
    const one = defineConfig({ ...base });
    const two = defineConfig({ ...base });
    expect(one).not.toBe(two);
    expect(listBlockDefinitions()).toHaveLength(2);
    expect(two.pages.blocks.map((b) => b.key)).toEqual(
      one.pages.blocks.map((b) => b.key),
    );
  });
});
