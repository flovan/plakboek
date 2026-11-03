import { describe, expect, it } from 'vitest';
import type { CatalogueEntry, CatalogueProperty } from '../../src/api-types.js';
import {
  findEditableField,
  findFieldForProperty,
  findZeroSizeFieldAt,
} from '../../src/client/text/field-target.js';
import { createTreeModel } from '../../src/client/session/tree-model.js';
import { block, buildNodes, column, section } from './support/model.js';

type Fake = {
  readonly nodeType: 1;
  readonly tagName: string;
  readonly parentElement: Fake | null;
  getAttribute(name: string): string | null;
  closest(selector: string): Fake | null;
};

/** An element with attributes, enough for the shape-based lookups. */
function element(
  tagName: string,
  attributes: Record<string, string>,
  parent: Fake | null = null,
): Fake {
  const self: Fake = {
    nodeType: 1,
    tagName,
    parentElement: parent,
    getAttribute: (name) => attributes[name] ?? null,
    closest(selector) {
      const name = /^\[([^\]]+)\]$/.exec(selector)?.[1] ?? '';
      let at: Fake | null = self;
      while (at !== null) {
        if (at.getAttribute(name) !== null) return at;
        at = at.parentElement;
      }
      return null;
    },
  };
  return self;
}

const property = (
  key: string,
  fieldType: string,
  constraint: CatalogueProperty['constraint'] = 'none',
): CatalogueProperty => ({
  key,
  label: key,
  fieldType,
  widget: 'default',
  required: false,
  options: {},
  constraint,
});

const entry = (
  key: string,
  properties: readonly CatalogueProperty[],
): CatalogueEntry => ({
  key,
  kind: 'block',
  editor: { label: key },
  placement: {
    ownerTypes: ['page'],
    allowedParents: 'any',
    allowedChildren: 'none',
  },
  supportsFill: false,
  starterChildren: [],
  properties,
});

const catalogue = [
  entry('prose', [
    property('body', 'rich_text'),
    property('locked', 'rich_text', 'fixed'),
    property('caption', 'short_text'),
    { ...property('title', 'short_text'), options: { maxLength: 200 } },
    property('lockedTitle', 'short_text', 'fixed'),
    property('count', 'integer'),
  ]),
  entry('button', [
    property('label', 'short_text'),
    property('variant', 'select'),
    property('fixedLabel', 'short_text', 'fixed'),
    property('size', 'integer'),
    {
      ...property('link', 'link'),
      options: { labelProperty: 'label', variantProperty: 'variant' },
    },
    { ...property('bare', 'link'), options: {} },
    {
      ...property('wrong', 'link'),
      options: { labelProperty: 'size', variantProperty: 'label' },
    },
    {
      ...property('unknown', 'link'),
      options: { labelProperty: 'nobody', variantProperty: 'fixedLabel' },
    },
    property('lockedLink', 'link', 'fixed'),
  ]),
];
const model = createTreeModel(
  buildNodes([
    section('s', [column('c', [block('b', 'prose'), block('btn', 'button')])]),
  ]),
);

/** A block element holding a field element, as the host's markup does. */
function fieldIn(tag: string, key: string): { field: Fake; text: Fake } {
  const root = element('DIV', { 'data-pk-block': 'b' });
  const field = element(tag, { 'data-pk-field': key }, root);
  const text = element('P', {}, field);
  return { field, text };
}

/** A link field of the button block `btn`. */
function linkField(key: string): Fake {
  const root = element('DIV', { 'data-pk-block': 'btn' });
  return element('DIV', { 'data-pk-field': key }, root);
}

describe('findEditableField for a link field', () => {
  it('answers a button, with the label and style properties the link options name', () => {
    const field = linkField('link');
    const target = findEditableField(element('A', {}, field), model, catalogue);
    expect(target).toMatchObject({
      blockId: 'btn',
      key: 'link',
      kind: 'button',
      element: field,
      labelKey: 'label',
      variantKey: 'variant',
    });
  });

  it('answers a button with no sibling keys when the options name none', () => {
    const target = findEditableField(linkField('bare'), model, catalogue);
    expect(target?.kind).toBe('button');
    expect(target).not.toHaveProperty('labelKey');
    expect(target).not.toHaveProperty('variantKey');
  });

  it('ignores a named property of the wrong type, an unknown one and one the editor may not write', () => {
    for (const key of ['wrong', 'unknown']) {
      const target = findEditableField(linkField(key), model, catalogue);
      expect(target?.kind).toBe('button');
      expect(target).not.toHaveProperty('labelKey');
      expect(target).not.toHaveProperty('variantKey');
    }
  });

  it('answers null for a link property that is fixed', () => {
    expect(
      findEditableField(linkField('lockedLink'), model, catalogue),
    ).toBeNull();
  });
});

describe('findEditableField', () => {
  it('answers a rich text field of a known block, from a click anywhere inside it', () => {
    const { field, text } = fieldIn('DIV', 'body');
    for (const start of [field, text]) {
      const target = findEditableField(start, model, catalogue);
      expect(target).toMatchObject({
        blockId: 'b',
        key: 'body',
        kind: 'rich',
        element: field,
      });
    }
  });

  it('answers the text node of a click through its parent element', () => {
    const { field, text } = fieldIn('DIV', 'body');
    const textNode = { nodeType: 3, parentElement: text };
    expect(findEditableField(textNode, model, catalogue)?.element).toBe(field);
  });

  it('answers null for a field that is a button', () => {
    const { text } = fieldIn('BUTTON', 'body');
    expect(findEditableField(text, model, catalogue)).toBeNull();
  });

  it('answers a short text field as a plain one, with the property maxLength', () => {
    const { field } = fieldIn('H2', 'title');
    expect(findEditableField(field, model, catalogue)).toMatchObject({
      blockId: 'b',
      key: 'title',
      kind: 'plain',
      element: field,
      maxLength: 200,
    });
  });

  it('answers a short text field without a maxLength option with none', () => {
    const target = findEditableField(
      fieldIn('SPAN', 'caption').field,
      model,
      catalogue,
    );
    expect(target?.kind).toBe('plain');
    expect(target).not.toHaveProperty('maxLength');
  });

  it('answers null for a fixed property and for a type that is not text', () => {
    for (const key of ['locked', 'lockedTitle', 'count']) {
      expect(
        findEditableField(fieldIn('DIV', key).text, model, catalogue),
      ).toBeNull();
    }
  });

  it('answers null outside any block, for an unknown block and for an unknown key', () => {
    const lone = element('P', { 'data-pk-field': 'body' });
    expect(findEditableField(lone, model, catalogue)).toBeNull();
    const stranger = element('DIV', { 'data-pk-block': 'nobody' });
    const field = element('DIV', { 'data-pk-field': 'body' }, stranger);
    expect(findEditableField(field, model, catalogue)).toBeNull();
    expect(
      findEditableField(fieldIn('DIV', 'nokey').text, model, catalogue),
    ).toBeNull();
  });

  it('answers null for something that is not an element', () => {
    expect(findEditableField(null, model, catalogue)).toBeNull();
    expect(findEditableField({}, model, catalogue)).toBeNull();
    expect(findEditableField('text', model, catalogue)).toBeNull();
  });
});

describe('findFieldForProperty', () => {
  /** A document of fields, each inside the block it belongs to. */
  function documentOf(fields: readonly Fake[]) {
    return {
      querySelectorAll: (selector: string) =>
        selector === '[data-pk-field]' ? fields : [],
    };
  }

  it("finds the block's own field for a property", () => {
    const { field } = fieldIn('DIV', 'body');
    expect(
      findFieldForProperty(documentOf([field]), 'b', 'body', model, catalogue),
    ).toMatchObject({
      blockId: 'b',
      key: 'body',
      kind: 'rich',
      element: field,
    });
  });

  it('finds a field the block root itself carries', () => {
    const root = element('DIV', {
      'data-pk-block': 'btn',
      'data-pk-field': 'link',
    });
    expect(
      findFieldForProperty(documentOf([root]), 'btn', 'link', model, catalogue),
    ).toMatchObject({ blockId: 'btn', key: 'link', kind: 'button' });
  });

  it('skips a field of another block or another property', () => {
    const { field } = fieldIn('DIV', 'body');
    const doc = documentOf([field]);
    expect(
      findFieldForProperty(doc, 'btn', 'body', model, catalogue),
    ).toBeNull();
    expect(
      findFieldForProperty(doc, 'b', 'caption', model, catalogue),
    ).toBeNull();
  });

  it('answers null for a property the block does not mark, or one that is fixed', () => {
    expect(
      findFieldForProperty(documentOf([]), 'b', 'body', model, catalogue),
    ).toBeNull();
    const { field } = fieldIn('DIV', 'locked');
    expect(
      findFieldForProperty(
        documentOf([field]),
        'b',
        'locked',
        model,
        catalogue,
      ),
    ).toBeNull();
  });
});

describe('findZeroSizeFieldAt', () => {
  type Boxed = Fake & {
    getBoundingClientRect(): {
      left: number;
      top: number;
      width: number;
      height: number;
    };
    getClientRects(): { length: number };
    contains(node: unknown): boolean;
    display: string;
  };

  /** A field element placed at (10, 100) with the given size, display and client rect count. */
  function boxed(
    base: Fake,
    box: { width?: number; height?: number; display?: string; rects?: number },
  ): Boxed {
    return Object.assign(base, {
      display: box.display ?? 'block',
      getBoundingClientRect: () => ({
        left: 10,
        top: 100,
        width: box.width ?? 200,
        height: box.height ?? 0,
      }),
      getClientRects: () => ({ length: box.rects ?? 1 }),
      contains: (node: unknown) => node === base,
    });
  }

  function documentOf(
    fields: readonly Boxed[],
    under: unknown = null,
  ): Document {
    return {
      elementFromPoint: () => under,
      querySelectorAll: (selector: string) =>
        selector === '[data-pk-field]' ? fields : [],
      defaultView: {
        getComputedStyle: (target: Boxed) => ({ display: target.display }),
      },
    } as unknown as Document;
  }

  const at = (doc: Document, x = 40, y = 108, blockId = 'b') =>
    findZeroSizeFieldAt(doc, blockId, x, y, model, catalogue);

  it("answers the block's own empty field where its ghost box holds the point", () => {
    const { field } = fieldIn('DIV', 'body');
    expect(at(documentOf([boxed(field, {})]))).toMatchObject({
      blockId: 'b',
      key: 'body',
      kind: 'rich',
      element: field,
    });
  });

  it('answers a zero-width field, a plain field and the field the block root carries', () => {
    const narrow = boxed(fieldIn('DIV', 'body').field, {
      width: 0,
      height: 20,
    });
    expect(at(documentOf([narrow]), 20, 105)?.kind).toBe('rich');
    const plain = boxed(fieldIn('H2', 'title').field, {});
    expect(at(documentOf([plain]))?.kind).toBe('plain');
    const root = boxed(
      element('DIV', { 'data-pk-block': 'b', 'data-pk-field': 'body' }),
      {},
    );
    expect(at(documentOf([root]))).toMatchObject({ element: root });
  });

  it('answers the field where the element under the point is the field or holds it, and null where a sized element is painted over it', () => {
    const field = boxed(fieldIn('DIV', 'body').field, {});
    const holder = { contains: (node: unknown) => node === field };
    const sibling = { contains: (node: unknown) => node === sibling };
    expect(at(documentOf([field], field))?.element).toBe(field);
    expect(at(documentOf([field], holder))?.element).toBe(field);
    expect(at(documentOf([field], sibling))).toBeNull();
  });

  it('answers null outside every ghost box', () => {
    const doc = documentOf([boxed(fieldIn('DIV', 'body').field, {})]);
    expect(at(doc, 40, 130)).toBeNull();
    expect(at(doc, 5, 108)).toBeNull();
    expect(at(doc, 40, 99)).toBeNull();
  });

  it('never answers a sized field, a display: contents field or one with no client rects', () => {
    const field = (extra: Parameters<typeof boxed>[1]) =>
      boxed(fieldIn('DIV', 'body').field, extra);
    for (const doc of [
      documentOf([field({ height: 30 })]),
      documentOf([field({ display: 'contents', width: 0, height: 0 })]),
      documentOf([field({ rects: 0 })]),
    ]) {
      expect(at(doc)).toBeNull();
    }
  });

  it("never answers a nested block's field, a button field or another block's field", () => {
    const { field } = fieldIn('DIV', 'body');
    const doc = documentOf([boxed(field, {})]);
    expect(at(doc, 40, 108, 'btn')).toBeNull();
    const nested = element(
      'DIV',
      { 'data-pk-field': 'body' },
      element('DIV', { 'data-pk-block': 'inner' }, field),
    );
    expect(at(documentOf([boxed(nested, {})]))).toBeNull();
    const button = boxed(linkField('link'), {});
    expect(at(documentOf([button]), 40, 108, 'btn')).toBeNull();
  });
});
