import { describe, expect, it } from 'vitest';
import { PAGES_PACKAGE_NAME } from '../../src/index.js';

describe('@plakboek/pages entry point', () => {
  it('exports its own package name', () => {
    expect(PAGES_PACKAGE_NAME).toBe('@plakboek/pages');
  });
});
