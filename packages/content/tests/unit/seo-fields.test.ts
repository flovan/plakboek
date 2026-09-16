import { describe, expect, it } from 'vitest';
import {
  EMPTY_ENTRY_SEO,
  ENTRY_SEO_PROPERTIES,
  type EntrySeo,
  EntrySeoValidationError,
  SEO_CANONICAL_MAX_LENGTH,
  SEO_DESCRIPTION_MAX_LENGTH,
  SEO_TITLE_MAX_LENGTH,
  normalizeEntrySeo,
  validateEntrySeo,
} from '../../src/seo.js';

/** Narrows a thrown validation error to `EntrySeoValidationError` without a
 * conditional `expect(...)` call (oxlint's vitest/no-conditional-expect). */
function expectSeoValidationError(fn: () => unknown): EntrySeoValidationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof EntrySeoValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected validateEntrySeo to throw EntrySeoValidationError');
}

function codesOf(error: EntrySeoValidationError): readonly string[] {
  return error.issues.map((issue) => issue.code);
}

function propertiesOf(
  error: EntrySeoValidationError,
): readonly (string | null)[] {
  return error.issues.map((issue) => issue.property);
}

describe('normalizeEntrySeo', () => {
  it('turns null and undefined into a value equal to EMPTY_ENTRY_SEO', () => {
    expect(normalizeEntrySeo(null)).toEqual(EMPTY_ENTRY_SEO);
    expect(normalizeEntrySeo(undefined)).toEqual(EMPTY_ENTRY_SEO);
  });

  it('fills only absent properties on a partial stored value', () => {
    const result = normalizeEntrySeo({ title: 'Hello', noindex: true });
    expect(result).toEqual({
      ...EMPTY_ENTRY_SEO,
      title: 'Hello',
      noindex: true,
    });
  });

  it('is idempotent: normalizing its own output returns an equal value', () => {
    const once = normalizeEntrySeo({
      title: 'Hello',
      canonicalUrl: 'https://example.com',
    });
    const twice = normalizeEntrySeo(once);
    expect(twice).toEqual(once);
  });
});

describe('validateEntrySeo', () => {
  it('returns all seven properties with defaults filled and the object frozen', () => {
    const result = validateEntrySeo({ title: 'Hello' }, { seoEnabled: true });
    expect(result).toEqual({
      ...EMPTY_ENTRY_SEO,
      title: 'Hello',
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('D-46 completeness: ENTRY_SEO_PROPERTIES is exactly the seven documented properties, each round-tripping', () => {
    expect(ENTRY_SEO_PROPERTIES).toEqual([
      'title',
      'description',
      'imageAssetId',
      'canonicalUrl',
      'noindex',
      'nofollow',
      'sitemapInclude',
    ]);

    const submitted: Record<string, unknown> = {
      title: 'A title',
      description: 'A description',
      imageAssetId: 'asset_01H9',
      canonicalUrl: 'https://example.com/a',
      noindex: true,
      nofollow: true,
      sitemapInclude: false,
    };
    const result = validateEntrySeo(submitted, { seoEnabled: true });
    for (const key of ENTRY_SEO_PROPERTIES) {
      expect(result[key]).toEqual(submitted[key]);
    }
  });

  it('collapses an empty or whitespace-only title, description and canonicalUrl to null', () => {
    expect(
      validateEntrySeo({ title: '   ' }, { seoEnabled: true }).title,
    ).toBeNull();
    expect(
      validateEntrySeo({ description: '   ' }, { seoEnabled: true })
        .description,
    ).toBeNull();
    expect(
      validateEntrySeo({ canonicalUrl: '   ' }, { seoEnabled: true })
        .canonicalUrl,
    ).toBeNull();
  });

  describe('title/description length boundary', () => {
    it('accepts exactly SEO_TITLE_MAX_LENGTH code points and rejects one more', () => {
      const atLimit = 'a'.repeat(SEO_TITLE_MAX_LENGTH);
      const overLimit = 'a'.repeat(SEO_TITLE_MAX_LENGTH + 1);
      expect(
        validateEntrySeo({ title: atLimit }, { seoEnabled: true }).title,
      ).toBe(atLimit);
      const error = expectSeoValidationError(() =>
        validateEntrySeo({ title: overLimit }, { seoEnabled: true }),
      );
      expect(codesOf(error)).toEqual(['TITLE_TOO_LONG']);
    });

    it('accepts exactly SEO_DESCRIPTION_MAX_LENGTH code points and rejects one more', () => {
      const atLimit = 'a'.repeat(SEO_DESCRIPTION_MAX_LENGTH);
      const overLimit = 'a'.repeat(SEO_DESCRIPTION_MAX_LENGTH + 1);
      expect(
        validateEntrySeo({ description: atLimit }, { seoEnabled: true })
          .description,
      ).toBe(atLimit);
      const error = expectSeoValidationError(() =>
        validateEntrySeo({ description: overLimit }, { seoEnabled: true }),
      );
      expect(codesOf(error)).toEqual(['DESCRIPTION_TOO_LONG']);
    });

    it('counts astral characters as one code point each', () => {
      const astralTitle = '\u{1F600}'.repeat(SEO_TITLE_MAX_LENGTH);
      expect(
        validateEntrySeo({ title: astralTitle }, { seoEnabled: true }).title,
      ).toBe(astralTitle);
    });
  });

  describe('canonicalUrl', () => {
    it('accepts absolute http and https URLs', () => {
      expect(
        validateEntrySeo(
          { canonicalUrl: 'https://example.com/a' },
          { seoEnabled: true },
        ).canonicalUrl,
      ).toBe('https://example.com/a');
      expect(
        validateEntrySeo(
          { canonicalUrl: 'http://example.com' },
          { seoEnabled: true },
        ).canonicalUrl,
      ).toBe('http://example.com');
    });

    it.each([
      ['a non-http scheme', 'javascript:alert(1)'],
      ['a protocol-relative value', '//evil.example'],
      ['a bare path', '/about'],
      [
        'a value over the length cap',
        `https://example.com/${'a'.repeat(SEO_CANONICAL_MAX_LENGTH)}`,
      ],
    ])('rejects %s as INVALID_CANONICAL_URL', (_label, value) => {
      const error = expectSeoValidationError(() =>
        validateEntrySeo({ canonicalUrl: value }, { seoEnabled: true }),
      );
      expect(codesOf(error)).toEqual(['INVALID_CANONICAL_URL']);
    });
  });

  describe('imageAssetId', () => {
    it('accepts a valid opaque asset id', () => {
      expect(
        validateEntrySeo({ imageAssetId: 'asset_01H9' }, { seoEnabled: true })
          .imageAssetId,
      ).toBe('asset_01H9');
    });

    it.each([
      ['a space-containing value', 'has space'],
      ['an empty string', ''],
      ['a 129-character id', 'a'.repeat(129)],
    ])('rejects %s as INVALID_IMAGE_ASSET_ID', (_label, value) => {
      const error = expectSeoValidationError(() =>
        validateEntrySeo({ imageAssetId: value }, { seoEnabled: true }),
      );
      expect(codesOf(error)).toEqual(['INVALID_IMAGE_ASSET_ID']);
    });
  });

  describe('boolean flags', () => {
    it.each(['noindex', 'nofollow', 'sitemapInclude'] as const)(
      '%s accepts only real booleans, rejecting string and numeric truthy values',
      (key) => {
        const stringError = expectSeoValidationError(() =>
          validateEntrySeo({ [key]: 'true' }, { seoEnabled: true }),
        );
        expect(codesOf(stringError)).toEqual(['INVALID_FLAG']);

        const numberError = expectSeoValidationError(() =>
          validateEntrySeo({ [key]: 1 }, { seoEnabled: true }),
        );
        expect(codesOf(numberError)).toEqual(['INVALID_FLAG']);
      },
    );

    it('false is a real value rather than an absent one', () => {
      const result = validateEntrySeo(
        { sitemapInclude: false },
        { seoEnabled: true },
      );
      expect(result.sitemapInclude).toBe(false);
    });
  });

  it('collects every problem in ENTRY_SEO_PROPERTIES order with unknown properties last, deterministically', () => {
    const submit = () =>
      expectSeoValidationError(() =>
        validateEntrySeo(
          { title: 1, description: 2, canonicalUrl: 'ftp://x', bogus: true },
          { seoEnabled: true },
        ),
      );

    const first = submit();
    expect(codesOf(first)).toEqual([
      'INVALID_TITLE',
      'INVALID_DESCRIPTION',
      'INVALID_CANONICAL_URL',
      'UNKNOWN_PROPERTY',
    ]);
    expect(propertiesOf(first)).toEqual([
      'title',
      'description',
      'canonicalUrl',
      'bogus',
    ]);

    const second = submit();
    expect(codesOf(second)).toEqual(codesOf(first));
    expect(propertiesOf(second)).toEqual(propertiesOf(first));
  });

  describe('seoEnabled: false', () => {
    it('accepts an absent, null or all-default value', () => {
      expect(validateEntrySeo(null, { seoEnabled: false })).toEqual(
        EMPTY_ENTRY_SEO,
      );
      expect(validateEntrySeo(undefined, { seoEnabled: false })).toEqual(
        EMPTY_ENTRY_SEO,
      );
      const defaultValue: EntrySeo = { ...EMPTY_ENTRY_SEO };
      expect(validateEntrySeo(defaultValue, { seoEnabled: false })).toEqual(
        EMPTY_ENTRY_SEO,
      );
    });

    it('throws SEO_NOT_ENABLED for a non-default value', () => {
      const error = expectSeoValidationError(() =>
        validateEntrySeo({ title: 'Hello' }, { seoEnabled: false }),
      );
      expect(codesOf(error)).toEqual(['SEO_NOT_ENABLED']);
    });
  });

  it('rejects a non-object value as INVALID_SEO_VALUE', () => {
    for (const value of ['a string', ['an', 'array'], 42]) {
      const error = expectSeoValidationError(() =>
        validateEntrySeo(value, { seoEnabled: true }),
      );
      expect(codesOf(error)).toEqual(['INVALID_SEO_VALUE']);
    }
  });
});
