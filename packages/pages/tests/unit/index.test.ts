import { describe, expect, it } from 'vitest';
import {
  defineBlocks,
  definePagesConfig,
  getBlockDefinition,
  PagesConfigError,
} from '../../src/index.js';

describe('@plakboek/pages entry point', () => {
  it('exports the block registry and pages config helpers', () => {
    const blocks = defineBlocks([
      {
        key: 'hero',
        editor: { label: 'Hero' },
        schemaVersion: 1,
        properties: {},
      },
    ]);
    expect(blocks).toHaveLength(1);
    expect(getBlockDefinition('hero').key).toBe('hero');
  });

  it('throws PagesConfigError when no blocks are declared', () => {
    expect(() =>
      definePagesConfig({
        content: { locales: ['en'], defaultLocale: 'en', timezone: 'UTC' },
        blocks: [],
      }),
    ).toThrow(PagesConfigError);
  });
});
