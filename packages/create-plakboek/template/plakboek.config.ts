import { defaultRoles, defineConfig } from '@plakboek/core/config';
import { heading } from './blocks/heading.tsx';
import { section } from './blocks/section.tsx';
import { seed } from './seed.ts';

// This file is loaded by Node (the plakboek CLI) as well as by Vite, so it
// imports plain modules only: nothing that exists only in the Vite build, and
// nothing from app/.
export default defineConfig({
  siteName: '__SITE_NAME__',
  defaultLocale: '__DEFAULT_LOCALE__',
  locales: ['__LOCALES__'],
  timezone: '__TIMEZONE__',

  // Every block is listed here explicitly. A new block is one file in
  // blocks/ exporting one defineBlock(...) definition, plus one entry below.
  blocks: [section, heading],

  // The permission list belongs to the CMS; only the mapping from role to
  // permissions is yours. Spread the defaults and add or override roles.
  roles: { ...defaultRoles },

  menus: { main: [{ label: 'Home', href: '/' }] },
  constraints: [],
  modules: [],

  // The page a fresh installation starts with (see seed.ts).
  seed,
});
