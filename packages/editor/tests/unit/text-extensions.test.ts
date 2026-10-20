import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getSchema } from '@tiptap/core';
import { Node as ProseNode, type Schema } from '@tiptap/pm/model';
import {
  DEFAULT_TEXT_THEME,
  resolveTextTheme,
  type TextThemeInput,
} from '@plakboek/content/rich-text';
import { describe, expect, it } from 'vitest';
import {
  buildTextExtensions,
  starterKitOptionsFor,
} from '../../src/client/text/extensions.js';

type Json = {
  readonly type: string;
  readonly content?: readonly Json[];
  readonly marks?: readonly { readonly type: string }[];
};

type Fixture = { name: string; theme: string; doc: Json };

const shapes = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../content/tests/fixtures/rich-text/shapes.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as { valid: Fixture[] };

const schemaFor = (input: TextThemeInput): Schema =>
  getSchema(buildTextExtensions(resolveTextTheme(input)));

/** Every node and mark name a document uses. */
function typesIn(node: Json, into = new Set<string>()): Set<string> {
  into.add(node.type);
  for (const mark of node.marks ?? []) into.add(mark.type);
  for (const child of node.content ?? []) typesIn(child, into);
  return into;
}

describe('the editor schema of the default theme', () => {
  const schema = getSchema(buildTextExtensions(DEFAULT_TEXT_THEME));

  it('has no level 1 heading, in any parse rule', () => {
    const rules = schema.nodes.heading?.spec.parseDOM ?? [];
    expect(rules.map((rule) => rule.tag)).toEqual(['h2', 'h3', 'h4']);
    expect(
      rules.some((rule) => 'attrs' in rule && rule.attrs?.level === 1),
    ).toBe(false);
  });

  it('holds the nodes and marks the theme names that this editor supports', () => {
    expect(Object.keys(schema.nodes).sort()).toEqual([
      'blockquote',
      'bulletList',
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

  it('gives a numbered list a start and nothing else', () => {
    expect(Object.keys(schema.nodes.orderedList?.spec.attrs ?? {})).toEqual([
      'start',
    ]);
  });
});

describe('a narrowed theme', () => {
  it('leaves out the marks, nodes and heading levels it does not name', () => {
    const schema = schemaFor({
      marks: ['bold', 'italic'],
      nodes: [],
      headingLevels: [],
    });
    expect(Object.keys(schema.marks).sort()).toEqual(['bold', 'italic']);
    expect(schema.nodes.heading).toBeUndefined();
    expect(schema.nodes.bulletList).toBeUndefined();
    expect(schema.nodes.orderedList).toBeUndefined();
    expect(schema.nodes.listItem).toBeUndefined();
    expect(schema.nodes.blockquote).toBeUndefined();
    expect(schema.marks.underline).toBeUndefined();
    expect(schema.marks.strike).toBeUndefined();
  });

  it('keeps only the heading levels it names', () => {
    const schema = schemaFor({ headingLevels: [2] });
    expect(
      schema.nodes.heading?.spec.parseDOM?.map((rule) => rule.tag),
    ).toEqual(['h2']);
  });

  it('turns every option of the base off that its theme leaves out', () => {
    const options = starterKitOptionsFor(
      resolveTextTheme({ marks: ['bold'], nodes: [] }),
    );
    expect(options.bold).toEqual({});
    expect(options.italic).toBe(false);
    expect(options.hardBreak).toBe(false);
    expect(options.horizontalRule).toBe(false);
    expect(options.code).toBe(false);
    expect(options.link).toBe(false);
  });
});

describe('the schema against the stored fixtures', () => {
  const schema = getSchema(buildTextExtensions(DEFAULT_TEXT_THEME));
  const known = new Set([
    ...Object.keys(schema.nodes),
    ...Object.keys(schema.marks),
  ]);
  // The editor joins neighbouring text runs that carry the same marks, so that
  // one fixture reads back merged (checked on its own below).
  const MERGED = 'adjacent text nodes with identical marks';
  const applicable = shapes.valid.filter(
    (fixture) =>
      fixture.theme === 'lean' &&
      fixture.name !== MERGED &&
      [...typesIn(fixture.doc)].every((type) => known.has(type)),
  );

  it('has fixtures to compare (the filter is not vacuous)', () => {
    expect(applicable.length).toBeGreaterThanOrEqual(10);
  });

  it.each(applicable.map((fixture) => [fixture.name, fixture.doc] as const))(
    'reads %s back as the same stored document',
    (_name, doc) => {
      const node = ProseNode.fromJSON(schema, doc);
      node.check();
      expect(node.toJSON()).toEqual(doc);
    },
  );

  it('joins neighbouring runs with the same marks into one', () => {
    const fixture = shapes.valid.find((item) => item.name === MERGED);
    if (fixture === undefined) throw new Error('The fixture is missing');
    const node = ProseNode.fromJSON(schema, fixture.doc);
    const runs = node.firstChild?.childCount ?? 0;
    expect(runs).toBe(1);
    expect(node.textContent).toBe('one two');
  });
});
