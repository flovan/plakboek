import { PAGES_PACKAGE_NAME } from '@plakboek/pages';

// Runtime kind check. Nothing below opens a connection or applies a
// migration: it is a pure equality check against the packed package.

function fail(reason: string): never {
  console.error(`pages.ts: ${reason}`);
  process.exit(1);
}

if (PAGES_PACKAGE_NAME !== '@plakboek/pages') {
  fail(
    `PAGES_PACKAGE_NAME resolved to "${PAGES_PACKAGE_NAME}", expected "@plakboek/pages"`,
  );
}

console.log('pages.ts: PAGES_PACKAGE_NAME resolves against the packed package');
