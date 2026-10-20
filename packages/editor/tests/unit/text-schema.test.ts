import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import {
  LOCKED_STARTER_KIT_OPTIONS,
  buildLockedExtensions,
} from '../../src/client/text/extensions.js';

/** StarterKit extensions that take no configuration and are always registered. */
const UNCONFIGURABLE = ['doc', 'text'];

/** Option keys are lower camel case, extension names sometimes capitalise a word (dropCursor). */
const normalise = (names: string[]): string[] =>
  names.map((name) => name.toLowerCase()).sort();

describe('the locked base text schema', () => {
  const schema = getSchema(buildLockedExtensions());

  it('holds exactly the allowed nodes and marks', () => {
    expect(Object.keys(schema.nodes).sort()).toEqual([
      'blockquote',
      'bulletList',
      'cta',
      'doc',
      'hardBreak',
      'heading',
      'horizontalRule',
      'listItem',
      'orderedList',
      'paragraph',
      'text',
    ]);
    expect(Object.keys(schema.marks).sort()).toEqual([
      'bold',
      'italic',
      'link',
      'strike',
      'underline',
    ]);
  });

  it('parses only h2, h3 and h4 as headings', () => {
    const tags = schema.nodes.heading?.spec.parseDOM?.map((rule) => rule.tag);
    expect(tags).toEqual(['h2', 'h3', 'h4']);
  });

  it('names every extension the installed StarterKit registers', () => {
    const addExtensions = StarterKit.config.addExtensions as unknown as (this: {
      options: object;
    }) => { name: string }[];
    const registered = addExtensions
      .call({ options: {} })
      .map((extension) => extension.name);
    expect(
      normalise([
        ...Object.keys(LOCKED_STARTER_KIT_OPTIONS),
        ...UNCONFIGURABLE,
      ]),
    ).toEqual(normalise(registered));
  });
});
