import {
  adoptChromeStyles,
  bootEditor,
  chromeStyleSheet,
} from '@plakboek/editor/client';
import {
  CHROME_STYLE_CSP_HASH,
  chromeStyleElement,
  createEditEntrypoint,
} from '@plakboek/editor/server';

const failures: string[] = [];

function expectEqual(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    failures.push(
      `${label}: expected ${String(expected)}, received ${String(actual)}`,
    );
  }
}

expectEqual(
  'CHROME_STYLE_CSP_HASH',
  CHROME_STYLE_CSP_HASH.startsWith('sha256-'),
  true,
);
expectEqual('adoptChromeStyles', typeof adoptChromeStyles, 'function');
expectEqual('chromeStyleSheet', typeof chromeStyleSheet, 'function');
expectEqual('bootEditor', typeof bootEditor, 'function');
expectEqual('createEditEntrypoint', typeof createEditEntrypoint, 'function');
expectEqual(
  'chromeStyleElement markup',
  chromeStyleElement().startsWith('<style>'),
  true,
);
expectEqual(
  'chromeStyleElement carries no relative unit',
  /\d(?:rem|em)\b/.test(chromeStyleElement()),
  false,
);

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('editor.ts: both subpaths resolve from the packed package');
