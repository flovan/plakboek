/**
 * The block catalogue the editor opens a page with, built on the server from
 * the resolved block properties so the client never needs the pages package.
 *
 * A property an installation hides is absent here, not flagged: it never
 * leaves the server. A fixed or narrowed property carries its constraint so
 * the client can show the value as locked or offer only the allowed choices.
 */
import {
  resolveBlockProperties,
  type BlockDefinition,
  type PagesConfig,
} from '@plakboek/pages';
import type { CatalogueEntry, CatalogueProperty } from '../api-types.js';

function toProperty(
  key: string,
  property: ReturnType<typeof resolveBlockProperties>[string],
): CatalogueProperty | null {
  if (property.constraint === 'hidden') return null;
  return Object.freeze({
    key,
    label: property.label,
    ...(property.description !== undefined
      ? { description: property.description }
      : {}),
    fieldType: property.fieldType,
    // `defineBlocks` always resolves a widget; the fallback only satisfies
    // the optional type.
    widget: property.widget ?? '',
    required: property.required === true,
    ...(property.defaultValue !== undefined
      ? { defaultValue: property.defaultValue }
      : {}),
    options: property.options ?? {},
    constraint: property.constraint,
    ...(property.constraint === 'fixed'
      ? { fixedValue: property.fixedValue }
      : {}),
    ...(property.constraint === 'narrowed' &&
    property.allowedValues !== undefined
      ? { allowedValues: Object.freeze([...property.allowedValues]) }
      : {}),
  });
}

function toEntry(definition: BlockDefinition): CatalogueEntry {
  const properties = Object.entries(resolveBlockProperties(definition)).flatMap(
    ([key, property]) => {
      const entry = toProperty(key, property);
      return entry === null ? [] : [entry];
    },
  );
  const { editor, placement } = definition;
  return Object.freeze({
    key: definition.key,
    kind: definition.kind,
    editor: Object.freeze({
      label: editor.label,
      ...(editor.description !== undefined
        ? { description: editor.description }
        : {}),
      ...(editor.icon !== undefined ? { icon: editor.icon } : {}),
      ...(editor.category !== undefined ? { category: editor.category } : {}),
    }),
    placement: Object.freeze({
      ownerTypes: Object.freeze([...placement.ownerTypes]),
      allowedParents:
        placement.allowedParents === 'any'
          ? 'any'
          : Object.freeze([...placement.allowedParents]),
      allowedChildren:
        placement.allowedChildren === 'any' ||
        placement.allowedChildren === 'none'
          ? placement.allowedChildren
          : Object.freeze([...placement.allowedChildren]),
    }),
    supportsFill: definition.layoutSupport.fill,
    starterChildren: definition.starterChildren,
    properties: Object.freeze(properties),
  });
}

/** One entry per declared block, in declaration order. */
export function buildCatalogue(
  config: Pick<PagesConfig, 'blocks'>,
): readonly CatalogueEntry[] {
  return Object.freeze(config.blocks.map(toEntry));
}
