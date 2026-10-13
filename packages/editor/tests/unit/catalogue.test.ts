/**
 * The block catalogue the editor opens a page with: what an installation
 * hides never appears, what it fixes or narrows carries its constraint, and a
 * column entry has a kind and no properties.
 */
import { defineContentConfig } from '@plakboek/content';
import {
  constrainBlock,
  defineBlocks,
  definePagesConfig,
} from '@plakboek/pages';
import { describe, expect, it } from 'vitest';
import { buildCatalogue } from '../../src/server/catalogue.js';

const choices = {
  choices: [
    { value: 'sm', labels: { en: 'Small' } },
    { value: 'lg', labels: { en: 'Large' } },
    { value: 'xl', labels: { en: 'Extra large' } },
  ],
};

const config = definePagesConfig({
  content: defineContentConfig({
    locales: ['en'],
    defaultLocale: 'en',
    timezone: 'UTC',
  }),
  blocks: defineBlocks([
    {
      key: 'column',
      kind: 'column',
      editor: { label: 'Column' },
      schemaVersion: 1,
      properties: {},
    },
    {
      key: 'section',
      kind: 'section',
      editor: { label: 'Section' },
      schemaVersion: 1,
      properties: {},
    },
    {
      key: 'card',
      editor: { label: 'Card', description: 'A card', category: 'Content' },
      schemaVersion: 1,
      layout: { fill: true },
      placement: { allowedParents: ['column'] },
      properties: {
        title: {
          fieldType: 'short_text',
          label: 'Title',
          required: true,
          options: { maxLength: 80 },
          defaultValue: 'Untitled',
        },
        anchor: {
          fieldType: 'short_text',
          label: 'Anchor',
          options: { maxLength: 40 },
        },
        padding: { fieldType: 'select', label: 'Padding', options: choices },
        size: { fieldType: 'select', label: 'Size', options: choices },
      },
    },
  ]),
  constraints: [
    constrainBlock('card', {
      anchor: 'hidden',
      padding: { fixed: 'lg' },
      size: { allow: ['sm', 'lg'] },
    }),
  ],
});

describe('buildCatalogue', () => {
  const catalogue = buildCatalogue(config);
  const card = catalogue.find((entry) => entry.key === 'card');

  it('lists every declared block in declaration order', () => {
    expect(catalogue.map((entry) => entry.key)).toEqual([
      'column',
      'section',
      'card',
    ]);
  });

  it('leaves a hidden property out entirely', () => {
    expect(card?.properties.map((property) => property.key)).toEqual([
      'title',
      'padding',
      'size',
    ]);
  });

  it('carries a fixed property’s value', () => {
    const padding = card?.properties.find(
      (property) => property.key === 'padding',
    );
    expect(padding?.constraint).toBe('fixed');
    expect(padding?.fixedValue).toBe('lg');
    expect(padding?.allowedValues).toBeUndefined();
  });

  it('carries a narrowed property’s allowed values', () => {
    const size = card?.properties.find((property) => property.key === 'size');
    expect(size?.constraint).toBe('narrowed');
    expect(size?.allowedValues).toEqual(['sm', 'lg']);
    expect(size?.fixedValue).toBeUndefined();
  });

  it('describes an unconstrained property completely', () => {
    const title = card?.properties.find((property) => property.key === 'title');
    expect(title).toMatchObject({
      key: 'title',
      label: 'Title',
      fieldType: 'short_text',
      required: true,
      defaultValue: 'Untitled',
      options: { maxLength: 80 },
      constraint: 'none',
    });
    expect(typeof title?.widget).toBe('string');
    expect(title?.widget).not.toBe('');
  });

  it('carries the placement rules, layout support and editor metadata', () => {
    expect(card).toMatchObject({
      kind: 'block',
      editor: { label: 'Card', description: 'A card', category: 'Content' },
      supportsFill: true,
      placement: { allowedParents: ['column'], allowedChildren: 'none' },
    });
    expect(catalogue.find((entry) => entry.key === 'section')).toMatchObject({
      kind: 'section',
      supportsFill: false,
      placement: { allowedParents: 'any', allowedChildren: 'any' },
    });
  });

  it('gives a column entry its kind and no properties', () => {
    const column = catalogue.find((entry) => entry.key === 'column');
    expect(column?.kind).toBe('column');
    expect(column?.properties).toEqual([]);
  });

  it('is frozen, so one instance can serve every request', () => {
    expect(Object.isFrozen(catalogue)).toBe(true);
    expect(Object.isFrozen(card)).toBe(true);
    expect(Object.isFrozen(card?.properties)).toBe(true);
  });
});
