/**
 * `definePagesConfig` as the single registration door (EXT-02, D-07):
 * `fieldTypes` then `widgets` then `blocks`, each in array order, with a
 * `HostRegistrationError` from either forwarded call surfacing unchanged
 * rather than being wrapped in `PagesConfigError`.
 */
import { HostRegistrationError, getFieldTypeWidgets } from '@plakboek/content';
import { defineContentConfig } from '@plakboek/content';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { definePagesConfig } from '../../src/config.js';
import { defineBlocks } from '../../src/registry.js';

const content = defineContentConfig({
  locales: ['en'],
  defaultLocale: 'en',
  timezone: 'UTC',
});

describe('definePagesConfig: single registration door (EXT-02, D-07)', () => {
  it('registers fieldTypes before widgets, so a widget targeting a config-declared field type resolves', () => {
    definePagesConfig({
      content,
      fieldTypes: [
        {
          fieldType: 'config_star_rating',
          optionsSchema: z.strictObject({}),
          buildValueSchema: () => z.unknown(),
          isEmptyValue: () => false,
          widgets: ['stars'] as const,
          defaultWidget: 'stars',
          allowedInRepeater: false,
        },
      ],
      widgets: [{ fieldType: 'config_star_rating', widget: 'numeric-stars' }],
      blocks: defineBlocks([
        {
          key: 'configDoor',
          editor: { label: 'Config door' },
          schemaVersion: 1,
          properties: {},
        },
      ]),
    });

    expect(getFieldTypeWidgets('config_star_rating')).toContain(
      'numeric-stars',
    );
  });

  it('lets a HostRegistrationError from registerHostFieldType propagate unchanged, not wrapped in PagesConfigError', () => {
    let caught: unknown;
    try {
      definePagesConfig({
        content,
        fieldTypes: [
          {
            fieldType: 'Not Valid!',
            optionsSchema: z.strictObject({}),
            buildValueSchema: () => z.unknown(),
            isEmptyValue: () => false,
            widgets: ['stars'] as const,
            defaultWidget: 'stars',
            allowedInRepeater: false,
          },
        ],
        blocks: defineBlocks([
          {
            key: 'brokenFieldType',
            editor: { label: 'Broken' },
            schemaVersion: 1,
            properties: {},
          },
        ]),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HostRegistrationError);
  });

  it('lets a HostRegistrationError from registerHostWidget propagate unchanged (unknown field type)', () => {
    let caught: unknown;
    try {
      definePagesConfig({
        content,
        widgets: [{ fieldType: 'does-not-exist', widget: 'whatever' }],
        blocks: defineBlocks([
          {
            key: 'brokenWidget',
            editor: { label: 'Broken' },
            schemaVersion: 1,
            properties: {},
          },
        ]),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HostRegistrationError);
  });
});
