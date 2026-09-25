/**
 * `lintSectionProperties`/`reportSectionLint` (BLOCK-05, D-17, 01 D-15): a
 * pure classification pass over section-kind `BlockDefinition`s, and its
 * never-throws reporting wrapper. Exercised against `defineBlocks`-produced
 * definitions so every case is proven against the real registry/field-type
 * pipeline, not a hand-built stand-in.
 */
import { FIELD_TYPES } from '@plakboek/content';
import { describe, expect, it, vi } from 'vitest';
import { defineBlocks, type BlockDefinition } from '../../src/registry.js';
import {
  lintSectionProperties,
  reportSectionLint,
  SECTION_LINT_FIELD_TYPES,
  SECTION_LINT_PROPERTY_SUBSTRINGS,
  type SectionLintFinding,
} from '../../src/section-lint.js';

function defineSection(
  properties: Record<
    string,
    { fieldType: string; label: string; options?: unknown }
  >,
  overrides: { lintExempt?: boolean } = {},
): BlockDefinition {
  const [section] = defineBlocks([
    {
      key: 'contentSection',
      kind: 'section',
      editor: { label: 'Content Section' },
      schemaVersion: 1,
      properties,
      ...(overrides.lintExempt !== undefined
        ? { lintExempt: overrides.lintExempt }
        : {}),
    },
  ]);
  if (section === undefined) throw new Error('defineBlocks returned nothing');
  return section;
}

describe('SECTION_LINT_FIELD_TYPES / SECTION_LINT_PROPERTY_SUBSTRINGS', () => {
  it('every flagged field type is a real, registered field type', () => {
    for (const fieldType of SECTION_LINT_FIELD_TYPES) {
      expect(FIELD_TYPES).toContain(fieldType);
    }
  });

  it("is exactly D-17's four field types", () => {
    expect([...SECTION_LINT_FIELD_TYPES].sort()).toEqual(
      ['long_text', 'reference', 'repeater', 'rich_text'].sort(),
    );
  });

  it("is exactly D-17's six property-name substrings", () => {
    expect([...SECTION_LINT_PROPERTY_SUBSTRINGS].sort()).toEqual(
      ['body', 'cta', 'heading', 'label', 'text', 'title'].sort(),
    );
  });
});

describe('lintSectionProperties (BLOCK-05, D-17)', () => {
  it('flags a rich_text property with the section key, property key and reason content-field-type', () => {
    const section = defineSection({
      summary: { fieldType: 'rich_text', label: 'Summary', options: {} },
    });
    const findings = lintSectionProperties([section]);
    expect(findings).toEqual([
      expect.objectContaining({
        blockKey: 'contentSection',
        propertyKey: 'summary',
        reason: 'content-field-type',
      }),
    ]);
  });

  it('flags a short_text property named heading with reason content-property-name', () => {
    const section = defineSection({
      heading: { fieldType: 'short_text', label: 'Heading', options: {} },
    });
    const findings = lintSectionProperties([section]);
    expect(findings).toEqual([
      expect.objectContaining({
        blockKey: 'contentSection',
        propertyKey: 'heading',
        reason: 'content-property-name',
      }),
    ]);
  });

  it('matches the substring case-insensitively against the property key', () => {
    // BLOCK_PROPERTY_KEY_PATTERN requires a key to start lowercase, so the
    // capitalisation that exercises case-insensitivity here sits mid-key
    // ("mainHeading" lowercases to "mainheading", containing "heading").
    const section = defineSection({
      mainHeading: {
        fieldType: 'short_text',
        label: 'Main Heading',
        options: {},
      },
    });
    const findings = lintSectionProperties([section]);
    expect(
      findings.some(
        (finding) =>
          finding.propertyKey === 'mainHeading' &&
          finding.reason === 'content-property-name',
      ),
    ).toBe(true);
  });

  it('does not flag layout-shaped properties (width: select, background: short_text)', () => {
    const section = defineSection({
      width: {
        fieldType: 'select',
        label: 'Width',
        options: {
          choices: [{ value: 'full', labels: { en: 'Full' } }],
        },
      },
      background: {
        fieldType: 'short_text',
        label: 'Background',
        options: {},
      },
    });
    expect(lintSectionProperties([section])).toEqual([]);
  });

  it('never flags a non-section block, even with a rich_text property named body', () => {
    const [block] = defineBlocks([
      {
        key: 'richBlock',
        kind: 'block',
        editor: { label: 'Rich Block' },
        schemaVersion: 1,
        properties: {
          body: { fieldType: 'rich_text', label: 'Body', options: {} },
        },
      },
    ]);
    if (block === undefined) throw new Error('defineBlocks returned nothing');
    expect(lintSectionProperties([block])).toEqual([]);
  });

  it('a lintExempt section with a rich_text property produces no content findings and one exempt finding', () => {
    const section = defineSection(
      { summary: { fieldType: 'rich_text', label: 'Summary', options: {} } },
      { lintExempt: true },
    );
    const findings = lintSectionProperties([section]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      blockKey: 'contentSection',
      reason: 'exempt',
    });
  });

  it('a property matching both reasons produces one finding per reason', () => {
    const section = defineSection({
      body: { fieldType: 'rich_text', label: 'Body', options: {} },
    });
    const findings = lintSectionProperties([section]);
    const reasons = findings
      .filter((finding) => finding.propertyKey === 'body')
      .map((finding) => finding.reason)
      .sort();
    expect(reasons).toEqual(['content-field-type', 'content-property-name']);
  });
});

describe('reportSectionLint (never throws)', () => {
  function findings(): readonly SectionLintFinding[] {
    return [
      {
        blockKey: 'contentSection',
        propertyKey: 'summary',
        reason: 'content-field-type',
        detail: 'flagged',
      },
    ];
  }

  it('returns normally when the supplied hook throws', () => {
    expect(() =>
      reportSectionLint(
        {
          onSectionLint: () => {
            throw new Error('hook boom');
          },
        },
        findings(),
        () => new Date('2026-09-25T00:00:00.000Z'),
      ),
    ).not.toThrow();
  });

  it('returns normally when the supplied hook returns a rejected promise', async () => {
    // An async host hook, or one written in plain JS, can hand back a
    // rejected promise even though the contract says void.
    expect(() =>
      reportSectionLint(
        {
          onSectionLint: (): undefined =>
            Promise.reject(new Error('async boom')) as unknown as undefined,
        },
        findings(),
        () => new Date('2026-09-25T00:00:00.000Z'),
      ),
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('calls the console default when no hook is supplied', () => {
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      reportSectionLint(
        undefined,
        findings(),
        () => new Date('2026-09-25T00:00:00.000Z'),
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message] = warnSpy.mock.calls[0] ?? [];
      expect(String(message)).toContain('contentSection');
      expect(String(message)).toContain('summary');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('calls nothing at all when findings is empty', () => {
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      reportSectionLint(undefined, [], () => new Date());
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns void', () => {
    const result = reportSectionLint(
      undefined,
      [],
      () => new Date('2026-09-25T00:00:00.000Z'),
    );
    expect(result).toBeUndefined();
  });
});
