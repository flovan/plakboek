import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  collectRichTextPageIds,
  isCompleteCta,
  isEmptyRichTextDocument,
  isRichTextDocumentInTheme,
  resolveTextTheme,
  stripOutOfTheme,
  validateRichTextDocument,
  type RichTextDocument,
  type TextThemeInput,
} from '../../src/rich-text/index.js';

type ValidFixture = {
  readonly name: string;
  readonly theme: string;
  readonly doc: unknown;
};
type InvalidFixture = ValidFixture & { readonly codes: readonly string[] };
type Shapes = {
  readonly themes: Readonly<Record<string, TextThemeInput>>;
  readonly valid: readonly ValidFixture[];
  readonly invalid: readonly InvalidFixture[];
};

const shapes = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../fixtures/rich-text/shapes.json', import.meta.url),
    ),
    'utf8',
  ),
) as Shapes;

function themeNamed(name: string) {
  const input = shapes.themes[name];
  if (input === undefined) throw new Error(`unknown fixture theme ${name}`);
  return resolveTextTheme(input);
}

function codesOf(doc: unknown, themeName: string): string[] {
  return [
    ...new Set(
      validateRichTextDocument(doc, themeNamed(themeName)).map(
        (issue) => issue.code,
      ),
    ),
  ].toSorted();
}

/** Every word a document holds: text nodes and CTA labels, in order. */
function collectText(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  if (Array.isArray(value)) return value.map(collectText).join('');
  const node = value as Record<string, unknown>;
  let text = typeof node.text === 'string' ? node.text : '';
  if (node.type === 'cta') {
    const label = (node.attrs as Record<string, unknown> | undefined)?.label;
    if (typeof label === 'string') text += label;
  }
  return text + collectText(node.content);
}

function paragraph(text: string) {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

describe('validateRichTextDocument: the frozen stored shapes', () => {
  it('has enough fixtures to freeze every node and mark', () => {
    expect(shapes.valid.length).toBeGreaterThanOrEqual(15);
    expect(shapes.invalid.length).toBeGreaterThanOrEqual(12);
  });

  it.each(shapes.valid.map((fixture) => [fixture.name, fixture] as const))(
    'accepts %s',
    (_name, fixture) => {
      expect(
        validateRichTextDocument(fixture.doc, themeNamed(fixture.theme)),
      ).toEqual([]);
    },
  );

  it.each(shapes.invalid.map((fixture) => [fixture.name, fixture] as const))(
    'refuses %s with the expected codes',
    (_name, fixture) => {
      expect(codesOf(fixture.doc, fixture.theme)).toEqual([...fixture.codes]);
    },
  );

  it('refuses a heading level 1 under every fixture theme', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Title' }],
        },
      ],
    };
    for (const name of Object.keys(shapes.themes)) {
      expect(validateRichTextDocument(doc, themeNamed(name))).toEqual([
        { path: 'content.0', code: 'NODE_NOT_ALLOWED' },
      ]);
    }
  });

  it('names the path of the offending value', () => {
    const doc = {
      type: 'doc',
      content: [
        paragraph('ok'),
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'x',
              marks: [{ type: 'bold' }, { type: 'link', attrs: {} }],
            },
          ],
        },
      ],
    };
    expect(
      validateRichTextDocument(doc, resolveTextTheme()).map(
        (issue) => issue.path,
      ),
    ).toContain('content.1.content.0.marks.1.attrs');
  });

  it('refuses a value that is not a document', () => {
    for (const value of [
      null,
      undefined,
      'text',
      3,
      [],
      { type: 'paragraph' },
    ]) {
      expect(
        validateRichTextDocument(value, resolveTextTheme()).length,
      ).toBeGreaterThan(0);
    }
  });

  it('never echoes a submitted value in an issue', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          secretKey: 'SECRET-ONE',
          content: [
            {
              type: 'text',
              text: 'SECRET-TWO',
              marks: [
                { type: 'link', attrs: { href: 'javascript:SECRET-THREE' } },
                { type: 'SECRET-FOUR' },
              ],
            },
          ],
        },
        { type: 'SECRET-FIVE', content: [] },
      ],
    };
    const issues = validateRichTextDocument(doc, resolveTextTheme());
    expect(issues.length).toBeGreaterThan(0);
    // A key name is a path segment, never a value; everything else must not
    // appear at all.
    const serialised = JSON.stringify(issues);
    for (const secret of ['TWO', 'THREE', 'FOUR', 'FIVE']) {
      expect(serialised).not.toContain(`SECRET-${secret}`);
    }
  });

  it('does not depend on the order of keys or of marks', () => {
    const theme = themeNamed('full');
    const marks = [
      { type: 'bold' },
      { type: 'link', attrs: { target: '_blank', pageId: null, href: '/a' } },
      { type: 'textColor', attrs: { value: null, token: 'accent' } },
    ];
    const forward = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ text: 'x', marks, type: 'text' }],
        },
      ],
    };
    const backward = {
      content: [
        {
          content: [{ type: 'text', marks: marks.toReversed(), text: 'x' }],
          type: 'paragraph',
        },
      ],
      type: 'doc',
    };
    expect(validateRichTextDocument(forward, theme)).toEqual([]);
    expect(validateRichTextDocument(backward, theme)).toEqual([]);
  });

  it('answers a hostile nesting depth with an issue instead of a stack overflow', () => {
    let nested: Record<string, unknown> = paragraph('deep');
    for (let level = 0; level < 20_000; level += 1) {
      nested = { type: 'blockquote', content: [nested] };
    }
    const doc = { type: 'doc', content: [nested] };
    const theme = resolveTextTheme();
    const codes = validateRichTextDocument(doc, theme).map(
      (issue) => issue.code,
    );
    expect(codes).toContain('TOO_DEEP');
    expect(() => stripOutOfTheme(doc, theme)).not.toThrow();
    expect(isRichTextDocumentInTheme(stripOutOfTheme(doc, theme), theme)).toBe(
      true,
    );
  });
});

describe('stripOutOfTheme', () => {
  const everyFixture = [
    ...shapes.valid.map((fixture) => [fixture.name, fixture] as const),
    ...shapes.invalid.map((fixture) => [fixture.name, fixture] as const),
  ];

  it.each(everyFixture)(
    'returns a document that validates and keeps every word for %s',
    (_name, fixture) => {
      const theme = themeNamed(fixture.theme);
      const stripped = stripOutOfTheme(fixture.doc, theme);
      expect(stripped).not.toBeNull();
      expect(validateRichTextDocument(stripped, theme)).toEqual([]);
      expect(collectText(stripped)).toBe(collectText(fixture.doc));
    },
  );

  it('keeps all text when a heading level 1 becomes a paragraph', () => {
    const stripped = stripOutOfTheme(
      {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: 'Page title' }],
          },
        ],
      },
      resolveTextTheme(),
    );
    expect(stripped).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Page title' }] },
      ],
    });
  });

  it('unwraps a disallowed blockquote and list into paragraphs', () => {
    const theme = resolveTextTheme({ marks: ['bold'], nodes: [] });
    const stripped = stripOutOfTheme(
      {
        type: 'doc',
        content: [
          { type: 'blockquote', content: [paragraph('quoted')] },
          {
            type: 'bulletList',
            content: [{ type: 'listItem', content: [paragraph('item')] }],
          },
        ],
      },
      theme,
    );
    expect(stripped).toEqual({
      type: 'doc',
      content: [paragraph('quoted'), paragraph('item')],
    });
  });

  it('splits a paragraph at a hard break the theme does not allow', () => {
    const theme = resolveTextTheme({ nodes: [] });
    const stripped = stripOutOfTheme(
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'one' },
              { type: 'hardBreak' },
              { type: 'text', text: 'two' },
            ],
          },
        ],
      },
      theme,
    );
    expect(stripped).toEqual({
      type: 'doc',
      content: [paragraph('one'), paragraph('two')],
    });
  });

  it('turns a cta the theme does not allow into a paragraph holding its label', () => {
    const theme = resolveTextTheme({ nodes: [] });
    const stripped = stripOutOfTheme(
      {
        type: 'doc',
        content: [
          {
            type: 'cta',
            attrs: { label: 'Contact', href: '/c', variant: 'primary' },
          },
        ],
      },
      theme,
    );
    expect(stripped).toEqual({ type: 'doc', content: [paragraph('Contact')] });
  });

  it('drops marks and attributes the theme does not allow', () => {
    const stripped = stripOutOfTheme(
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { textAlign: 'center' },
            content: [
              {
                type: 'text',
                text: 'x',
                marks: [
                  { type: 'bold' },
                  { type: 'link', attrs: { href: 'javascript:alert(1)' } },
                  { type: 'code' },
                ],
              },
            ],
          },
        ],
      },
      resolveTextTheme(),
    );
    expect(stripped).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }] }],
        },
      ],
    });
  });

  it('returns null when the input is not a document at all', () => {
    for (const value of [null, undefined, 'x', 3, [], { type: 'paragraph' }]) {
      expect(stripOutOfTheme(value, resolveTextTheme())).toBeNull();
    }
  });

  it('drops a custom colour or size mark when the theme allows no palette, as the validator does', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'x',
              marks: [
                { type: 'textColor', attrs: { token: null, value: '#ffffff' } },
                { type: 'textSize', attrs: { token: null, value: '18px' } },
              ],
            },
          ],
        },
      ],
    };
    const themes = [
      resolveTextTheme(),
      resolveTextTheme({ colors: [], sizes: [] }),
      resolveTextTheme({
        colors: [{ token: 'brand', label: 'Brand' }],
      }),
    ];
    for (const theme of themes) {
      const stripped = stripOutOfTheme(doc, theme);
      expect(validateRichTextDocument(stripped, theme)).toEqual([]);
      expect(collectText(stripped)).toBe('x');
    }
    expect(JSON.stringify(stripOutOfTheme(doc, themes[0]!))).not.toContain(
      'textColor',
    );
  });

  it('leaves a document that already fits the theme unchanged', () => {
    const theme = themeNamed('full');
    for (const fixture of shapes.valid) {
      if (fixture.theme !== 'full') continue;
      const stripped = stripOutOfTheme(fixture.doc, theme);
      expect(validateRichTextDocument(stripped, theme)).toEqual([]);
    }
  });
});

describe('isEmptyRichTextDocument', () => {
  it('treats null, an empty doc and a doc of empty paragraphs as empty', () => {
    expect(isEmptyRichTextDocument(null)).toBe(true);
    expect(isEmptyRichTextDocument(undefined)).toBe(true);
    expect(isEmptyRichTextDocument({ type: 'doc' })).toBe(true);
    expect(isEmptyRichTextDocument({ type: 'doc', content: [] })).toBe(true);
    expect(
      isEmptyRichTextDocument({
        type: 'doc',
        content: [{ type: 'paragraph' }, { type: 'paragraph', content: [] }],
      }),
    ).toBe(true);
  });

  it('treats a document holding text, a CTA or a divider as not empty', () => {
    expect(
      isEmptyRichTextDocument({ type: 'doc', content: [paragraph('hi')] }),
    ).toBe(false);
    expect(
      isEmptyRichTextDocument({
        type: 'doc',
        content: [{ type: 'cta', attrs: { label: '' } }],
      }),
    ).toBe(false);
    expect(
      isEmptyRichTextDocument({
        type: 'doc',
        content: [{ type: 'paragraph' }, { type: 'horizontalRule' }],
      }),
    ).toBe(false);
  });
});

describe('collectRichTextPageIds', () => {
  const first = '0b5f4c1e-3c52-4a53-9a61-2f2b9d0f7c11';
  const second = '7d3a9e20-1b44-4f0c-8e5a-6c1d2b3a4f55';

  it('returns each distinct page id from links and CTAs once, in document order', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'a',
              marks: [{ type: 'link', attrs: { pageId: second } }],
            },
            {
              type: 'text',
              text: 'b',
              marks: [{ type: 'link', attrs: { pageId: first } }],
            },
          ],
        },
        { type: 'cta', attrs: { label: 'x', pageId: second } },
        { type: 'cta', attrs: { label: 'y', pageId: first } },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: 'c',
                      marks: [
                        {
                          type: 'link',
                          attrs: {
                            pageId: '8a8a8a8a-1111-4222-8333-444444444444',
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(collectRichTextPageIds(doc)).toEqual([
      second,
      first,
      '8a8a8a8a-1111-4222-8333-444444444444',
    ]);
  });

  it('ignores hrefs and values that are not page ids', () => {
    expect(
      collectRichTextPageIds({
        type: 'doc',
        content: [
          { type: 'cta', attrs: { label: 'x', href: '/a', pageId: 'home' } },
        ],
      }),
    ).toEqual([]);
    expect(collectRichTextPageIds(null)).toEqual([]);
  });
});

describe('isCompleteCta', () => {
  it('needs a label and exactly one usable target', () => {
    expect(isCompleteCta({ label: 'Go', href: '/go' })).toBe(true);
    expect(
      isCompleteCta({
        label: 'Go',
        pageId: '0b5f4c1e-3c52-4a53-9a61-2f2b9d0f7c11',
      }),
    ).toBe(true);
    expect(isCompleteCta({ label: '', href: '/go' })).toBe(false);
    expect(isCompleteCta({ label: '   ', href: '/go' })).toBe(false);
    expect(isCompleteCta({ label: 'Go' })).toBe(false);
    expect(isCompleteCta({ label: 'Go', href: 'javascript:alert(1)' })).toBe(
      false,
    );
    expect(isCompleteCta(null)).toBe(false);
  });
});

describe('a theme-checked document is a RichTextDocument', () => {
  it('lets a stripped value be used as one', () => {
    const doc: RichTextDocument | null = stripOutOfTheme(
      { type: 'doc' },
      resolveTextTheme(),
    );
    expect(doc).toEqual({ type: 'doc' });
  });
});
