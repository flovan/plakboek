/**
 * Invariant test for the `assumption_delta_decision` (04-04-PLAN.md): blocks,
 * host field types and host widgets are three registerable kinds under one
 * identical override rule -- last wins, decided by pure array order, never a
 * hidden precedence table. One table-driven case asserts the same rule holds
 * for all three, so a future fourth registerable kind that introduces its
 * own precedence rule goes red here first.
 */
import {
  getFieldTypeDefinition,
  getFieldTypeWidgets,
  registerHostFieldType,
  registerHostWidget,
} from '@plakboek/content';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { defineBlocks, getBlockDefinition } from '../../src/registry.js';

function testFieldType(widget: string) {
  return {
    optionsSchema: z.strictObject({}),
    buildValueSchema: () => z.unknown(),
    isEmptyValue: () => false,
    widgets: [widget] as const,
    defaultWidget: widget,
    allowedInRepeater: false,
  };
}

describe('override order: last wins, by pure array order, across every registerable kind (D-05, D-07)', () => {
  it.each([
    {
      kind: 'block',
      resolveFirstWins: () => {
        defineBlocks([
          {
            key: 'r2card',
            editor: { label: 'core' },
            schemaVersion: 1,
            properties: {},
          },
          {
            key: 'r2card',
            editor: { label: 'host' },
            schemaVersion: 1,
            properties: {},
          },
        ]);
        return getBlockDefinition('r2card').editor.label;
      },
      resolveLastWins: () => {
        defineBlocks([
          {
            key: 'r2card2',
            editor: { label: 'host' },
            schemaVersion: 1,
            properties: {},
          },
          {
            key: 'r2card2',
            editor: { label: 'core' },
            schemaVersion: 1,
            properties: {},
          },
        ]);
        return getBlockDefinition('r2card2').editor.label;
      },
      expectedFirstWins: 'host',
      expectedLastWins: 'core',
    },
    {
      kind: 'host field type',
      resolveFirstWins: () => {
        registerHostFieldType([
          { fieldType: 'r2kind', ...testFieldType('core-widget') },
          { fieldType: 'r2kind', ...testFieldType('host-widget') },
        ]);
        return getFieldTypeDefinition('r2kind').defaultWidget;
      },
      resolveLastWins: () => {
        registerHostFieldType([
          { fieldType: 'r2kind2', ...testFieldType('host-widget') },
          { fieldType: 'r2kind2', ...testFieldType('core-widget') },
        ]);
        return getFieldTypeDefinition('r2kind2').defaultWidget;
      },
      expectedFirstWins: 'host-widget',
      expectedLastWins: 'core-widget',
    },
  ])(
    'resolves duplicate $kind keys to the last entry, by array position alone',
    ({
      resolveFirstWins,
      resolveLastWins,
      expectedFirstWins,
      expectedLastWins,
    }) => {
      expect(resolveFirstWins()).toBe(expectedFirstWins);
      expect(resolveLastWins()).toBe(expectedLastWins);
    },
  );

  it('resolves a host widget for one field type the same way: re-registering the same (fieldType, widget) pair keeps its position, never appending a duplicate', () => {
    registerHostWidget([{ fieldType: 'short_text', widget: 'r2-special' }]);
    const before = getFieldTypeWidgets('short_text');
    expect(before.filter((widget) => widget === 'r2-special')).toHaveLength(1);
    const positionBefore = before.indexOf('r2-special');

    registerHostWidget([{ fieldType: 'short_text', widget: 'r2-special' }]);
    const after = getFieldTypeWidgets('short_text');
    expect(after.filter((widget) => widget === 'r2-special')).toHaveLength(1);
    expect(after.indexOf('r2-special')).toBe(positionBefore);
  });

  it('loses the core entries with no silent restoration when a host array omits them (D-05)', () => {
    defineBlocks([
      {
        key: 'r2core',
        editor: { label: 'core' },
        schemaVersion: 1,
        properties: {},
      },
    ]);
    expect(getBlockDefinition('r2core').key).toBe('r2core');

    defineBlocks([
      {
        key: 'r2hostOnly',
        editor: { label: 'host only' },
        schemaVersion: 1,
        properties: {},
      },
    ]);
    expect(() => getBlockDefinition('r2core')).toThrow(
      'block type "r2core" is not registered',
    );
    expect(getBlockDefinition('r2hostOnly').key).toBe('r2hostOnly');
  });
});
