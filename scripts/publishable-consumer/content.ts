import * as content from '@plakboek/content';

if (typeof content !== 'object') {
  process.exit(1);
}

// No connection, no side effects: the entry point is a placeholder export
// until plan 03-14 completes the barrel.
console.log(
  'content.ts: @plakboek/content resolves as an object from the packed package (no connection opened)',
);
