import type { MenuDefinitions, ResolvedMenuItem } from './types.js';

export type MenuIssue = {
  readonly code: 'INVALID_MENU' | 'INVALID_MENU_ITEM';
  readonly message: string;
};

export function validateMenus(_menus: unknown): readonly MenuIssue[] {
  return [];
}

export function resolveMenu(
  _menus: MenuDefinitions,
  _name: string,
  _context: {
    readonly locale: string;
    readonly defaultLocale: string;
    readonly publicPath: string | null;
  },
): readonly ResolvedMenuItem[] {
  return [];
}
