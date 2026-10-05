import { describe, expect, it } from 'vitest';
import { resolveMenu, validateMenus } from '../../src/menus.js';
import { defineModule } from '../../src/modules.js';
import type { MenuDefinitions } from '../../src/types.js';

const context = (
  overrides: Partial<{
    locale: string;
    defaultLocale: string;
    publicPath: string | null;
  }> = {},
) => ({
  locale: 'en',
  defaultLocale: 'en',
  publicPath: '/' as string | null,
  ...overrides,
});

describe('resolveMenu', () => {
  it('returns a plain string label unchanged', () => {
    const menus: MenuDefinitions = { main: [{ label: 'Home', href: '/' }] };
    expect(resolveMenu(menus, 'main', context())[0]?.label).toBe('Home');
  });

  it('picks the label for the page locale', () => {
    const menus: MenuDefinitions = {
      main: [{ label: { en: 'Home', nl: 'Start' }, href: '/' }],
    };
    expect(
      resolveMenu(menus, 'main', context({ locale: 'nl' }))[0]?.label,
    ).toBe('Start');
  });

  it('falls back to the default locale when the page locale has no label', () => {
    const menus: MenuDefinitions = {
      main: [{ label: { en: 'Home', nl: 'Start' }, href: '/' }],
    };
    expect(
      resolveMenu(menus, 'main', context({ locale: 'de' }))[0]?.label,
    ).toBe('Home');
  });

  it('falls back to the first value when neither locale has a label', () => {
    const menus: MenuDefinitions = {
      main: [{ label: { fr: 'Accueil', nl: 'Start' }, href: '/' }],
    };
    expect(
      resolveMenu(menus, 'main', context({ locale: 'de' }))[0]?.label,
    ).toBe('Accueil');
  });

  it('marks only the item whose root-relative href equals the public path', () => {
    const menus: MenuDefinitions = {
      main: [
        { label: 'Home', href: '/' },
        { label: 'About', href: '/about' },
      ],
    };
    const items = resolveMenu(menus, 'main', context({ publicPath: '/about' }));
    expect(items.map((item) => item.current)).toEqual([false, true]);
  });

  it('normalises a trailing slash on either side', () => {
    const menus: MenuDefinitions = {
      main: [
        { label: 'Home', href: '/' },
        { label: 'About', href: '/about/' },
      ],
    };
    expect(
      resolveMenu(menus, 'main', context({ publicPath: '/about' }))[1]?.current,
    ).toBe(true);
    expect(
      resolveMenu(menus, 'main', context({ publicPath: '/' }))[0]?.current,
    ).toBe(true);
    expect(
      resolveMenu(menus, 'main', context({ publicPath: '/about/' }))[1]
        ?.current,
    ).toBe(true);
  });

  it('never marks an http(s) href as current', () => {
    const menus: MenuDefinitions = {
      main: [{ label: 'Docs', href: 'https://example.com/about' }],
    };
    expect(
      resolveMenu(menus, 'main', context({ publicPath: '/about' }))[0]?.current,
    ).toBe(false);
  });

  it('marks nothing when there is no public path', () => {
    const menus: MenuDefinitions = { main: [{ label: 'Home', href: '/' }] };
    expect(
      resolveMenu(menus, 'main', context({ publicPath: null }))[0]?.current,
    ).toBe(false);
  });

  it('returns an empty list for an undeclared or empty menu', () => {
    const menus: MenuDefinitions = { main: [], footer: [] };
    expect(resolveMenu(menus, 'missing', context())).toEqual([]);
    expect(resolveMenu(menus, 'main', context())).toEqual([]);
    expect(resolveMenu(menus, 'constructor', context())).toEqual([]);
  });
});

describe('validateMenus', () => {
  const issuesFor = (menus: unknown) => validateMenus(menus);

  it('accepts root-relative, fragment and http(s) hrefs', () => {
    expect(
      issuesFor({
        main: [
          { label: 'Home', href: '/' },
          { label: 'Team', href: '#team' },
          { label: 'Docs', href: 'https://example.com/docs' },
          { label: 'Plain', href: 'http://example.com' },
          { label: { en: 'Contact', nl: 'Contact' }, href: '/contact' },
        ],
      }),
    ).toEqual([]);
  });

  it('accepts no menus at all', () => {
    expect(issuesFor(undefined)).toEqual([]);
    expect(issuesFor({})).toEqual([]);
  });

  it('refuses a blank or missing label and names the menu and index', () => {
    const issues = issuesFor({
      main: [
        { label: 'Fine', href: '/' },
        { label: '   ', href: '/a' },
        { href: '/b' },
      ],
    });
    expect(issues.map((issue) => issue.code)).toEqual([
      'INVALID_MENU_ITEM',
      'INVALID_MENU_ITEM',
    ]);
    expect(issues[0]?.message).toContain('menus.main[1]');
    expect(issues[1]?.message).toContain('menus.main[2]');
  });

  it('refuses a label record with no non-empty value', () => {
    const issues = issuesFor({
      main: [{ label: { en: '', nl: ' ' }, href: '/' }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('menus.main[0]');
  });

  it('refuses a missing href', () => {
    const issues = issuesFor({ main: [{ label: 'Home' }] });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('menus.main[0]');
  });

  it('refuses javascript:, data: and other schemes', () => {
    const issues = issuesFor({
      main: [
        { label: 'a', href: 'javascript:alert(1)' },
        { label: 'b', href: 'data:text/html,hi' },
        { label: 'c', href: 'mailto:someone@example.com' },
        { label: 'd', href: 'ftp://example.com' },
        { label: 'e', href: 'about' },
      ],
    });
    expect(issues).toHaveLength(5);
  });

  it('refuses a protocol-relative href, including backslash and control-character forms', () => {
    const issues = issuesFor({
      main: [
        { label: 'a', href: '//evil.example.com' },
        { label: 'b', href: '/\\evil.example.com' },
        { label: 'c', href: '/\t/evil.example.com' },
        { label: 'd', href: '/about us' },
      ],
    });
    expect(issues).toHaveLength(4);
  });

  it('refuses a menu name that does not match the pattern', () => {
    const issues = issuesFor({ 'Main Menu': [] });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('INVALID_MENU');
  });

  it('refuses a menu that is not an array and an item that is not an object', () => {
    const issues = issuesFor({ main: 'nope', footer: [null, 'x'] });
    expect(issues.map((issue) => issue.code)).toEqual([
      'INVALID_MENU',
      'INVALID_MENU_ITEM',
      'INVALID_MENU_ITEM',
    ]);
  });

  it('does not echo a long offending value', () => {
    const long = `javascript:${'x'.repeat(500)}`;
    const issues = issuesFor({ main: [{ label: 'a', href: long }] });
    expect(issues[0]?.message.length).toBeLessThan(300);
    expect(issues[0]?.message).not.toContain('xxxxxxxxxx');
  });
});

describe('defineModule', () => {
  it('returns its argument unchanged', () => {
    const definition = { name: 'blog', blocks: [] };
    expect(defineModule(definition)).toBe(definition);
  });
});
