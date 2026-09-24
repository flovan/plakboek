import { describe, expect, it } from 'vitest';
import {
  ContentConfigError,
  defineContentConfig,
  type ContentConfigIssueCode,
} from '../../src/config.js';

describe('defineContentConfig (D-20)', () => {
  it('accepts a valid config and freezes the result', () => {
    const config = defineContentConfig({
      locales: ['en', 'nl'],
      defaultLocale: 'en',
      timezone: 'Europe/Brussels',
    });

    expect(config).toEqual({
      locales: ['en', 'nl'],
      defaultLocale: 'en',
      timezone: 'Europe/Brussels',
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.locales)).toBe(true);
  });

  it('rejects an unrecognized IANA time zone', () => {
    expect(() =>
      defineContentConfig({
        locales: ['en'],
        defaultLocale: 'en',
        timezone: 'Mars/Olympus',
      }),
    ).toThrow(ContentConfigError);
  });

  it('collects every issue code in one error, never throwing on the first bad field', () => {
    let caught: ContentConfigError | undefined;
    try {
      defineContentConfig({
        locales: ['en', 'not a locale', 'en'],
        defaultLocale: 'nl',
        timezone: 'Mars/Olympus',
      });
    } catch (error) {
      caught = error instanceof ContentConfigError ? error : undefined;
    }

    expect(caught).toBeInstanceOf(ContentConfigError);
    const codes = (caught?.issues ?? []).map((issue) => issue.code);
    const expectedCodes: ContentConfigIssueCode[] = [
      'INVALID_LOCALE',
      'DUPLICATE_LOCALE',
      'DEFAULT_LOCALE_NOT_ENABLED',
      'INVALID_TIMEZONE',
    ];
    for (const code of expectedCodes) {
      expect(codes).toContain(code);
    }
  });

  it('reports NO_LOCALES for an empty locale list', () => {
    let caught: ContentConfigError | undefined;
    try {
      defineContentConfig({
        locales: [],
        defaultLocale: 'en',
        timezone: 'UTC',
      });
    } catch (error) {
      caught = error instanceof ContentConfigError ? error : undefined;
    }

    expect(caught?.issues.map((issue) => issue.code)).toContain('NO_LOCALES');
  });
});
