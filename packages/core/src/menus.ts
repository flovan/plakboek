/**
 * Code-declared menus: validation at config evaluation and pure resolution
 * per page. Imports types only, so this module adds no runtime code to any
 * bundle that reaches it.
 *
 * The href rule keeps script-bearing URLs out of rendered anchors: only a
 * single-slash root-relative path, a `#` fragment or an absolute http(s) URL
 * is accepted. `javascript:`, `data:`, protocol-relative `//` and the
 * backslash and whitespace forms browsers normalise into one are refused.
 */
import type { MenuDefinitions, ResolvedMenuItem } from './types.js';

export type MenuIssue = {
  readonly code: 'INVALID_MENU' | 'INVALID_MENU_ITEM';
  readonly message: string;
};

export const MENU_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

const NAME_ECHO_LIMIT = 40;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** True when the string holds a space, a control character or DEL. */
function hasControlOrSpace(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

const hasText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

function echo(value: string): string {
  const printable = value.replace(/[^\x21-\x7e]/g, '?');
  return printable.length > NAME_ECHO_LIMIT
    ? `${printable.slice(0, NAME_ECHO_LIMIT)}...`
    : printable;
}

/** Why an href is refused, or `null` when it is acceptable. */
function hrefProblem(href: unknown): string | null {
  if (typeof href !== 'string' || href.length === 0) {
    return 'href must be a non-empty string';
  }
  if (hasControlOrSpace(href)) {
    return 'href must not contain whitespace or control characters';
  }
  if (href.startsWith('#')) return null;
  if (href.startsWith('/')) {
    return href.startsWith('//') || href.startsWith('/\\')
      ? 'href must not be protocol-relative'
      : null;
  }
  if (/^https?:\/\//i.test(href)) {
    try {
      new URL(href);
      return null;
    } catch {
      return 'href is not a valid absolute URL';
    }
  }
  return 'href must be a root-relative path, a #fragment or an http(s) URL';
}

function labelProblem(label: unknown): string | null {
  if (typeof label === 'string') {
    return hasText(label) ? null : 'label must not be blank';
  }
  if (isRecord(label)) {
    const values = Object.values(label);
    if (values.some((value) => typeof value !== 'string')) {
      return 'every label translation must be a string';
    }
    return values.some(hasText)
      ? null
      : 'label record needs at least one non-empty translation';
  }
  return 'label must be a string or a record keyed by locale';
}

/**
 * Collects one issue per offending menu or item, naming `menus.<name>` and
 * the item index. Never echoes a long value.
 */
export function validateMenus(menus: unknown): readonly MenuIssue[] {
  if (menus === undefined) return [];
  if (!isRecord(menus)) {
    return [
      {
        code: 'INVALID_MENU',
        message: 'menus must be an object keyed by name',
      },
    ];
  }

  const issues: MenuIssue[] = [];
  for (const [name, items] of Object.entries(menus)) {
    if (!MENU_NAME_PATTERN.test(name)) {
      issues.push({
        code: 'INVALID_MENU',
        message: `menus.${echo(name)}: menu name must match ${MENU_NAME_PATTERN.source}`,
      });
      continue;
    }
    if (!Array.isArray(items)) {
      issues.push({
        code: 'INVALID_MENU',
        message: `menus.${name}: a menu must be an array of items`,
      });
      continue;
    }
    items.forEach((item: unknown, index) => {
      const where = `menus.${name}[${index}]`;
      if (!isRecord(item)) {
        issues.push({
          code: 'INVALID_MENU_ITEM',
          message: `${where}: an item must be an object with a label and an href`,
        });
        return;
      }
      const problem = labelProblem(item.label) ?? hrefProblem(item.href);
      if (problem !== null) {
        issues.push({
          code: 'INVALID_MENU_ITEM',
          message: `${where}: ${problem}`,
        });
      }
    });
  }
  return issues;
}

function pickLabel(
  label: MenuDefinitions[string][number]['label'],
  locale: string,
  defaultLocale: string,
): string {
  if (typeof label === 'string') return label;
  const own = Object.hasOwn(label, locale) ? label[locale] : undefined;
  if (hasText(own)) return own;
  const fallback = Object.hasOwn(label, defaultLocale)
    ? label[defaultLocale]
    : undefined;
  if (hasText(fallback)) return fallback;
  return Object.values(label).find(hasText) ?? '';
}

function normalisePath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') || '/' : path;
}

const isRootRelative = (href: string): boolean =>
  href.startsWith('/') && !href.startsWith('//');

/**
 * One menu for one locale and one page. Pure: an undeclared menu is an empty
 * list, a label falls back to the default locale and then to any translation,
 * and `current` marks the item whose root-relative href is the page's path.
 */
export function resolveMenu(
  menus: MenuDefinitions,
  name: string,
  context: {
    readonly locale: string;
    readonly defaultLocale: string;
    readonly publicPath: string | null;
  },
): readonly ResolvedMenuItem[] {
  const items = Object.hasOwn(menus, name) ? menus[name] : undefined;
  if (items === undefined) return [];

  const here =
    context.publicPath === null ? null : normalisePath(context.publicPath);
  return items.map((item) => ({
    label: pickLabel(item.label, context.locale, context.defaultLocale),
    href: item.href,
    current:
      here !== null &&
      isRootRelative(item.href) &&
      normalisePath(item.href) === here,
  }));
}
