import { describe, expect, it } from 'vitest';
import {
  equalRatio,
  isEqualRatio,
  presetsFor,
  ratioLabelParts,
  ratioTerms,
} from '../../src/client/session/presets.js';

const builtIn = [
  '1',
  '1:1',
  '2:1',
  '1:2',
  '1:1:1',
  '2:1:1',
  '1:2:1',
  '1:1:2',
  '1:1:1:1',
];

describe('presetsFor', () => {
  it('offers the configured ratios for the count', () => {
    expect(presetsFor(1, builtIn)).toEqual(['1']);
    expect(presetsFor(2, builtIn)).toEqual(['1:1', '2:1', '1:2']);
    expect(presetsFor(3, builtIn)).toEqual([
      '1:1:1',
      '2:1:1',
      '1:2:1',
      '1:1:2',
    ]);
  });

  it('falls back to the equal split beyond every configured ratio', () => {
    expect(presetsFor(5, builtIn)).toEqual(['1:1:1:1:1']);
  });

  it('lists a host-added ratio after the built-in ones', () => {
    expect(presetsFor(2, [...builtIn, '3:1'])).toEqual([
      '1:1',
      '2:1',
      '1:2',
      '3:1',
    ]);
  });

  it('puts the equal split first when the host narrowed it away', () => {
    expect(presetsFor(2, ['2:1', '1:2'])).toEqual(['1:1', '2:1', '1:2']);
  });
});

describe('ratio helpers', () => {
  it('builds equal splits and recognises them', () => {
    expect(equalRatio(1)).toBe('1');
    expect(equalRatio(4)).toBe('1:1:1:1');
    expect(isEqualRatio('1:1:1')).toBe(true);
    expect(isEqualRatio('2:2')).toBe(true);
    expect(isEqualRatio('2:1')).toBe(false);
  });

  it('splits a ratio into its terms for the label', () => {
    expect(ratioTerms('1:2:1')).toEqual(['1', '2', '1']);
    expect(ratioLabelParts('1:2')).toEqual(['1', '2']);
  });
});
