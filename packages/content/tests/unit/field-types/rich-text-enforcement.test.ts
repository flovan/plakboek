import { afterEach, describe, expect, it } from 'vitest';
import {
  effectiveTextTheme,
  getTextTheme,
  registerTextTheme,
} from '../../../src/field-types/text-theme-registry.js';
import { LINK_FIELD_TYPE } from '../../../src/field-types/link.js';
import {
  getFieldTypeDefinition,
  parseFieldOptions,
} from '../../../src/field-types/registry.js';
import { richTextFieldType } from '../../../src/field-types/rich-text.js';
import {
  DEFAULT_TEXT_THEME,
  resolveTextTheme,
} from '../../../src/rich-text/index.js';

function paragraph(...content: readonly unknown[]): unknown {
  return { type: 'doc', content: [{ type: 'paragraph', content }] };
}

function text(value: string, marks?: readonly unknown[]): unknown {
  return marks === undefined
    ? { type: 'text', text: value }
    : { type: 'text', text: value, marks };
}

function messagesOf(
  options: Parameters<typeof richTextFieldType.buildValueSchema>[0],
  value: unknown,
): string[] {
  const result = richTextFieldType.buildValueSchema(options).safeParse(value);
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.message);
}

afterEach(() => {
  registerTextTheme(DEFAULT_TEXT_THEME);
});

describe('rich_text is held to the effective text theme', () => {
  it('refuses a level 1 heading', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [text('Title')] },
      ],
    };
    expect(messagesOf({}, doc)).toEqual(['NODE_NOT_ALLOWED at content.0']);
  });

  it('refuses a mark the theme does not know', () => {
    const doc = paragraph(text('x', [{ type: 'code' }]));
    expect(messagesOf({}, doc)).toHaveLength(1);
  });

  it('refuses a link with a script href, never echoing it', () => {
    const doc = paragraph(
      text('x', [{ type: 'link', attrs: { href: 'javascript:SECRET' } }]),
    );
    const messages = messagesOf({}, doc);
    expect(messages).toHaveLength(1);
    expect(messages.join()).not.toContain('SECRET');
  });

  it('follows the registered global theme', () => {
    const doc = paragraph(
      text('x', [
        { type: 'textColor', attrs: { token: 'accent', value: null } },
      ]),
    );
    const brand = paragraph(
      text('x', [
        { type: 'textColor', attrs: { token: 'brand', value: null } },
      ]),
    );
    expect(messagesOf({}, doc)).toHaveLength(1);

    registerTextTheme(
      resolveTextTheme({ colors: [{ label: 'Accent', token: 'accent' }] }),
    );
    expect(messagesOf({}, doc)).toEqual([]);
    expect(messagesOf({}, brand)).toHaveLength(1);
  });

  it('lets a property narrow the theme and never widen it', () => {
    const italic = paragraph(text('x', [{ type: 'italic' }]));
    expect(messagesOf({}, italic)).toEqual([]);
    expect(messagesOf({ narrow: { marks: ['bold'] } }, italic)).toHaveLength(1);
    expect(effectiveTextTheme({ narrow: { marks: ['bold'] } }).marks).toEqual([
      'bold',
    ]);
    expect(getTextTheme()).toBe(DEFAULT_TEXT_THEME);
  });

  it('falls back to the global theme for options that do not parse', () => {
    expect(effectiveTextTheme({ narrow: { marks: ['nope'] } })).toBe(
      getTextTheme(),
    );
  });

  it('accepts only a narrow option', () => {
    expect(
      richTextFieldType.optionsSchema.safeParse({ allowed: ['bold'] }).success,
    ).toBe(false);
    expect(
      richTextFieldType.optionsSchema.safeParse({ narrow: { marks: ['bold'] } })
        .success,
    ).toBe(true);
  });

  it('checks the size and depth caps before any theme rule', () => {
    let node: Record<string, unknown> = { type: 'text', text: 'leaf' };
    for (let level = 0; level < 40; level += 1) {
      node = { type: 'blockquote', content: [node] };
    }
    const messages = messagesOf({}, { type: 'doc', content: [node] });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('levels deep');
  });
});

describe('rich_text stored values', () => {
  it('holds an unchanged value to shape and size only', () => {
    const italic = paragraph(text('x', [{ type: 'italic' }]));
    const narrow = { narrow: { marks: ['bold' as const] } };
    expect(
      richTextFieldType.buildStoredValueSchema(narrow).safeParse(italic)
        .success,
    ).toBe(true);
    expect(
      richTextFieldType.buildStoredValueSchema(narrow).safeParse('<p>x</p>')
        .success,
    ).toBe(false);
  });

  it('holds a rich text inside a repeater item to shape and size only when the repeater is unchanged', () => {
    const repeater = getFieldTypeDefinition('repeater');
    const options = parseFieldOptions('repeater', {
      fields: [
        {
          key: 'body',
          label: 'Body',
          fieldType: 'rich_text',
          options: { narrow: { marks: ['bold'] } },
        },
      ],
    });
    const value = [{ body: paragraph(text('x', [{ type: 'italic' }])) }];
    expect(repeater.buildValueSchema(options).safeParse(value).success).toBe(
      false,
    );
    expect(
      repeater.buildStoredValueSchema?.(options).safeParse(value).success,
    ).toBe(true);
    expect(
      repeater
        .buildStoredValueSchema?.(options)
        .safeParse([{ body: '<p>x</p>' }]).success,
    ).toBe(false);
  });

  it('counts a document of empty paragraphs as empty', () => {
    expect(
      richTextFieldType.isEmptyValue({
        type: 'doc',
        content: [{ type: 'paragraph' }, { type: 'paragraph', content: [] }],
      }),
    ).toBe(true);
    expect(richTextFieldType.isEmptyValue(paragraph(text('Hi')))).toBe(false);
  });
});

describe('link field type', () => {
  it('accepts an address or a page id and refuses a script href', () => {
    const schema = LINK_FIELD_TYPE.buildValueSchema({});
    expect(
      schema.safeParse({ href: '/about', pageId: null, target: null }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        href: 'javascript:x',
        pageId: null,
        target: null,
      }).success,
    ).toBe(false);
  });

  it('is empty when neither an address nor a page is set', () => {
    expect(LINK_FIELD_TYPE.isEmptyValue(null)).toBe(true);
    expect(
      LINK_FIELD_TYPE.isEmptyValue({ href: null, pageId: null, target: null }),
    ).toBe(true);
    expect(
      LINK_FIELD_TYPE.isEmptyValue({ href: '/a', pageId: null, target: null }),
    ).toBe(false);
  });

  it('takes sibling label and variant property names as options', () => {
    expect(
      LINK_FIELD_TYPE.optionsSchema.safeParse({
        labelProperty: 'label',
        variantProperty: 'variant',
      }).success,
    ).toBe(true);
    expect(
      LINK_FIELD_TYPE.optionsSchema.safeParse({ labelProperty: 'Bad Key' })
        .success,
    ).toBe(false);
  });
});
