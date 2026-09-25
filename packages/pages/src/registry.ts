/**
 * Block declaration, registration and lookup (D-01, D-02, D-03, D-05,
 * D-16). `defineBlocks` mirrors `@plakboek/permissions`'s `RoleConfigError`
 * collect-then-throw shape; the module-level registry mirrors
 * `@plakboek/content`'s field-type registry's Map-keyed-by-string
 * registration, except this one is populated by the host calling
 * `defineBlocks` (block types are host-declared, not a fixed built-in set).
 * Block properties are typed fields reusing `@plakboek/content`'s
 * field-type registry (D-03): one validation engine, one options schema,
 * one widget system serve both content fields and block props.
 */
import {
  getFieldTypeDefinition,
  isFieldType,
  parseFieldOptions,
  type FieldType,
} from '@plakboek/content';

export type BlockPropertyDefinition = {
  readonly fieldType: FieldType;
  readonly label: string;
  readonly options?: unknown;
  readonly required?: boolean;
};

/** A block declares an upcaster per version step (D-10), keyed by the
 * TARGET version it upcasts to (e.g. `{ 2: v1ToV2 }` upcasts stored
 * version 1 to version 2). */
export type BlockUpcaster = (props: unknown, fromVersion: number) => unknown;

export type BlockKind = 'block' | 'section';

export type BlockDefinitionInput = {
  readonly key: string;
  readonly kind?: BlockKind;
  readonly label: string;
  readonly properties: Readonly<Record<string, BlockPropertyDefinition>>;
  readonly schemaVersion: number;
  readonly upcasters?: Readonly<Record<number, BlockUpcaster>>;
  readonly minSupportedVersion?: number;
  readonly component?: unknown;
};

/** The frozen, normalised form of a block declaration: `kind` defaulted to
 * `'block'`, `upcasters` defaulted to `{}`. */
export type BlockDefinition = {
  readonly key: string;
  readonly kind: BlockKind;
  readonly label: string;
  readonly properties: Readonly<Record<string, BlockPropertyDefinition>>;
  readonly schemaVersion: number;
  readonly upcasters: Readonly<Record<number, BlockUpcaster>>;
  readonly minSupportedVersion?: number;
  readonly component?: unknown;
};

export const BLOCK_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;

export type BlockConfigIssueCode =
  | 'INVALID_KEY'
  | 'INVALID_SCHEMA_VERSION'
  | 'INVALID_FIELD_TYPE'
  | 'INVALID_OPTIONS';

export type BlockConfigIssue = {
  readonly code: BlockConfigIssueCode;
  readonly key: string;
  readonly message: string;
};

/** Thrown by `defineBlocks` with every problem found across every entry,
 * collected before throwing once -- never fails on the first bad entry.
 * Mirrors `@plakboek/permissions`'s `RoleConfigError` shape. */
export class BlockConfigError extends Error {
  readonly issues: readonly BlockConfigIssue[];

  constructor(issues: readonly BlockConfigIssue[]) {
    super(
      [
        '[@plakboek/pages] invalid block config:',
        ...issues.map((issue) => issue.message),
      ].join('\n'),
    );
    this.name = 'BlockConfigError';
    this.issues = issues;
  }
}

/** Thrown when a `block_type`/registry key string has no registered
 * definition. */
export class UnknownBlockTypeError extends Error {
  readonly blockType: string;

  constructor(blockType: string) {
    super(`@plakboek/pages: block type "${blockType}" is not registered`);
    this.name = 'UnknownBlockTypeError';
    this.blockType = blockType;
  }
}

export type BlockPropsValidationIssue = {
  readonly propertyKey: string;
  readonly code: 'REQUIRED' | 'INVALID';
};

/** Thrown by `validateBlockProps`, naming every failing property key and
 * issue code only -- never the submitted value (mirrors
 * `@plakboek/content`'s `FieldValidationError`). */
export class BlockPropsValidationError extends Error {
  readonly issues: readonly BlockPropsValidationIssue[];

  constructor(issues: readonly BlockPropsValidationIssue[]) {
    super(
      [
        '[@plakboek/pages] invalid block props:',
        ...issues.map((issue) => `"${issue.propertyKey}": ${issue.code}`),
      ].join('\n'),
    );
    this.name = 'BlockPropsValidationError';
    this.issues = issues;
  }
}

// Keyed by plain `string`, populated by `defineBlocks` -- block types are a
// host-declared, host-extensible registry (D-01), not a fixed built-in set
// registered once at module load like `@plakboek/content`'s field types.
const registry = new Map<string, BlockDefinition>();

function toDefinition(entry: BlockDefinitionInput): BlockDefinition {
  return Object.freeze({
    key: entry.key,
    kind: entry.kind ?? 'block',
    label: entry.label,
    properties: Object.freeze({ ...entry.properties }),
    schemaVersion: entry.schemaVersion,
    upcasters: Object.freeze({ ...entry.upcasters }),
    ...(entry.minSupportedVersion !== undefined
      ? { minSupportedVersion: entry.minSupportedVersion }
      : {}),
    ...(entry.component !== undefined ? { component: entry.component } : {}),
  });
}

/**
 * Validates every block declaration and registers it (D-01, D-05, D-16).
 * Collects every problem across every entry -- an invalid key, a
 * non-integer or sub-1 `schemaVersion`, a property naming an unknown field
 * type, or options failing that field type's own `optionsSchema` -- before
 * throwing one `BlockConfigError`; never fails on the first bad entry.
 * Registration itself is same-key re-registration, last wins, by pure
 * array order (D-05): `entries` is iterated in order into a `Map`, so a
 * later entry with the same `key` overwrites an earlier one. Returns a
 * frozen array of the map's values, and this same call populates the
 * module-level registry `getBlockDefinition`/`listBlockDefinitions` read
 * from.
 */
export function defineBlocks(
  entries: readonly BlockDefinitionInput[],
): readonly BlockDefinition[] {
  const issues: BlockConfigIssue[] = [];
  const byKey = new Map<string, BlockDefinition>();

  for (const entry of entries) {
    if (!BLOCK_KEY_PATTERN.test(entry.key)) {
      issues.push({
        code: 'INVALID_KEY',
        key: entry.key,
        message: `block key "${entry.key}" must match ${BLOCK_KEY_PATTERN.source}`,
      });
      continue;
    }
    if (!Number.isInteger(entry.schemaVersion) || entry.schemaVersion < 1) {
      issues.push({
        code: 'INVALID_SCHEMA_VERSION',
        key: entry.key,
        message: `block "${entry.key}" schemaVersion must be an integer of at least 1`,
      });
      continue;
    }

    let entryHasPropertyIssue = false;
    for (const [propertyKey, property] of Object.entries(entry.properties)) {
      if (!isFieldType(property.fieldType)) {
        issues.push({
          code: 'INVALID_FIELD_TYPE',
          key: entry.key,
          message: `block "${entry.key}" property "${propertyKey}" has unknown field type "${String(property.fieldType)}"`,
        });
        entryHasPropertyIssue = true;
        continue;
      }
      try {
        parseFieldOptions(property.fieldType, property.options ?? {});
      } catch (error) {
        issues.push({
          code: 'INVALID_OPTIONS',
          key: entry.key,
          message: `block "${entry.key}" property "${propertyKey}" has invalid options: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        entryHasPropertyIssue = true;
      }
    }
    if (entryHasPropertyIssue) continue;

    byKey.set(entry.key, toDefinition(entry));
  }

  if (issues.length > 0) {
    throw new BlockConfigError(issues);
  }

  registry.clear();
  for (const [key, definition] of byKey) {
    registry.set(key, definition);
  }

  return Object.freeze([...byKey.values()]);
}

/** Reads a block's definition by its `block_type`/key, from the
 * module-level registry `defineBlocks` populates. Throws
 * `UnknownBlockTypeError` when absent. */
export function getBlockDefinition(key: string): BlockDefinition {
  const definition = registry.get(key);
  if (definition === undefined) {
    throw new UnknownBlockTypeError(key);
  }
  return definition;
}

export function listBlockDefinitions(): readonly BlockDefinition[] {
  return Object.freeze([...registry.values()]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a block instance's `props` against `definition.properties`
 * (T-04-01), reusing `@plakboek/content`'s field-type registry (D-03): one
 * validation engine serves both content fields and block props. Collects
 * every issue before throwing one `BlockPropsValidationError`, naming only
 * the property key and issue code, never the submitted value. Returns the
 * validated, parsed props object -- unknown input keys are dropped, exactly
 * like `@plakboek/content`'s own field validation.
 */
export function validateBlockProps(
  definition: BlockDefinition,
  props: unknown,
): Record<string, unknown> {
  const input = isPlainObject(props) ? props : {};
  const issues: BlockPropsValidationIssue[] = [];
  const validated: Record<string, unknown> = {};

  for (const [propertyKey, property] of Object.entries(definition.properties)) {
    const fieldDefinition = getFieldTypeDefinition(property.fieldType);
    const options = parseFieldOptions(
      property.fieldType,
      property.options ?? {},
    );
    const value: unknown = input[propertyKey];

    if (property.required === true && fieldDefinition.isEmptyValue(value)) {
      issues.push({ propertyKey, code: 'REQUIRED' });
      continue;
    }
    if (fieldDefinition.isEmptyValue(value)) {
      continue;
    }

    const result = fieldDefinition.buildValueSchema(options).safeParse(value);
    if (!result.success) {
      issues.push({ propertyKey, code: 'INVALID' });
      continue;
    }
    validated[propertyKey] = result.data;
  }

  if (issues.length > 0) {
    throw new BlockPropsValidationError(issues);
  }
  return validated;
}
