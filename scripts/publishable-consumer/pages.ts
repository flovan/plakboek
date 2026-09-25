import {
  DEFAULT_BLOCK_DEPTH_CEILING,
  DEFAULT_SECTION_NESTING_DEPTH,
} from '@plakboek/pages';

// Runtime kind check. Nothing below opens a connection or applies a
// migration: it is a pure equality check against the packed package.

function fail(reason: string): never {
  console.error(`pages.ts: ${reason}`);
  process.exit(1);
}

if (DEFAULT_SECTION_NESTING_DEPTH !== 2) {
  fail(
    `DEFAULT_SECTION_NESTING_DEPTH resolved to "${DEFAULT_SECTION_NESTING_DEPTH}", expected 2`,
  );
}

if (DEFAULT_BLOCK_DEPTH_CEILING !== 12) {
  fail(
    `DEFAULT_BLOCK_DEPTH_CEILING resolved to "${DEFAULT_BLOCK_DEPTH_CEILING}", expected 12`,
  );
}

console.log(
  'pages.ts: DEFAULT_SECTION_NESTING_DEPTH/DEFAULT_BLOCK_DEPTH_CEILING resolve against the packed package',
);
