/**
 * Block declaration, registration and lookup (D-01, D-02, D-03, D-05,
 * D-16). `defineBlocks` mirrors `@plakboek/permissions`'s `RoleConfigError`
 * collect-then-throw shape; the module-level registry mirrors
 * `@plakboek/content`'s field-type registry's Map-keyed-by-string
 * registration, except this one is populated by the host calling
 * `defineBlocks` (block types are host-declared, not a fixed built-in set).
 * Block properties are typed fields reusing `@plakboek/content`'s
 * field-type registry (D-03): one validation engine, one options schema,
 * one widget system serve both content fields and block props -- including
 * a host field type registered through `registerHostFieldType`, which is
 * why `fieldType` below is a plain `string`, not the closed `FieldType`
 * union: `getFieldTypeDefinition`/`getFieldTypeWidgets` already resolve a
 * host type by its own key, so a block property only ever needs a string.
 *
 * D-09: this registry has no on/off switch of any kind for a block. No
 * field on a block declaration marks whether a block may currently be used,
 * no registration config key flips one, and no lookup filters what it
 * returns by such a state. BLOCK-10's superadmin on/off controls belong
 * entirely to Phase 14, wired into the insertion paths then -- never here.
 */
import { getFieldTypeDefinition, getFieldTypeWidgets } from '@plakboek/content';
import { OWNER_TYPES, type OwnerType } from './types.js';

export type BlockPropertyDefinition = {
  readonly fieldType: string;
  readonly label: string;
  readonly options?: unknown;
  readonly required?: boolean;
  readonly widget?: string;
  readonly widgetOptions?: unknown;
  readonly defaultValue?: unknown;
  readonly description?: string;
};

/** A block's editor-facing metadata: how it is labelled, described and
 * grouped in the editor's block picker (BLOCK-06's "the editor renders
 * controls from that schema" flagged assumption -- this is the map Phase
 * 7/8 render from). */
export type BlockEditorMetadata = {
  readonly label: string;
  readonly description?: string;
  readonly icon?: string;
  readonly category?: string;
};

/** Where a block may legally sit in the tree. Absent fields default per
 * this type's own fields below -- `ownerTypes` to every value of
 * `OWNER_TYPES`, `allowedParents` to `'any'`, and `allowedChildren` to
 * `'none'` for `kind: 'block'` and `'any'` for `kind: 'section'`. Plan
 * 04-05 enforces these on write; Phase 8 reads the same declaration for
 * drop targets. */
export type BlockPlacement = {
  readonly ownerTypes?: readonly OwnerType[];
  readonly allowedParents?: readonly string[] | 'any';
  readonly allowedChildren?: readonly string[] | 'any' | 'none';
};

/** The frozen, normalised form of `BlockPlacement` every `BlockDefinition`
 * carries -- every field always present, defaults already resolved. */
export type ResolvedBlockPlacement = {
  readonly ownerTypes: readonly OwnerType[];
  readonly allowedParents: readonly string[] | 'any';
  readonly allowedChildren: readonly string[] | 'any' | 'none';
};

/** A block declares an upcaster per version step (D-10), keyed by the
 * TARGET version it upcasts to (e.g. `{ 2: v1ToV2 }` upcasts stored
 * version 1 to version 2). */
export type BlockUpcaster = (props: unknown, fromVersion: number) => unknown;

export type BlockKind = 'block' | 'section';

export type BlockDefinitionInput = {
  readonly key: string;
  readonly kind?: BlockKind;
  readonly editor: BlockEditorMetadata;
  readonly properties: Readonly<Record<string, BlockPropertyDefinition>>;
  readonly placement?: BlockPlacement;
  readonly schemaVersion: number;
  readonly minSupportedVersion?: number;
  readonly upcasters?: Readonly<Record<number, BlockUpcaster>>;
  /** Stays opaque: this package never imports or renders it, so a block
   * declaration can never drag editor-only code into the render path. */
  readonly component?: unknown;
  /** The section layout-lint opt-out plan 04-05's boot-time lint honours
   * (04-RESEARCH.md's D-17 discretion). */
  readonly lintExempt?: boolean;
};

/** One property's resolved installation constraint (D-04), attached to a
 * `BlockDefinition` by `applyBlockConstraints` (constraints.ts) -- never set
 * by `defineBlocks`/`toDefinition` itself. Values are already validated
 * against the property's own field-type schema by the time they land here. */
export type ResolvedPropertyConstraint =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'fixed'; readonly value: unknown }
  | { readonly kind: 'narrowed'; readonly allowedValues: readonly string[] };

/** The frozen, normalised form of a block declaration: `kind`, `placement`
 * and `upcasters` defaulted, and each property's `widget` resolved to the
 * field type's `defaultWidget` when omitted. `constraints`, when present, is
 * per-property installation constraints applied by `applyBlockConstraints`
 * (constraints.ts, plan 04-04 Task 2) -- absent until a host declares any. */
export type BlockDefinition = {
  readonly key: string;
  readonly kind: BlockKind;
  readonly editor: BlockEditorMetadata;
  readonly properties: Readonly<Record<string, BlockPropertyDefinition>>;
  readonly placement: ResolvedBlockPlacement;
  readonly schemaVersion: number;
  readonly minSupportedVersion?: number;
  readonly upcasters: Readonly<Record<number, BlockUpcaster>>;
  readonly component?: unknown;
  readonly lintExempt?: boolean;
  readonly constraints?: Readonly<Record<string, ResolvedPropertyConstraint>>;
};

export const BLOCK_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;
export const BLOCK_PROPERTY_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;

export type BlockConfigIssueCode =
  | 'INVALID_KEY'
  | 'INVALID_PROPERTY_KEY'
  | 'UNKNOWN_FIELD_TYPE'
  | 'INVALID_FIELD_OPTIONS'
  | 'UNKNOWN_WIDGET'
  | 'INVALID_SCHEMA_VERSION'
  | 'INVALID_MIN_SUPPORTED_VERSION'
  | 'UPCASTER_GAP'
  | 'UPCASTER_OUT_OF_RANGE'
  | 'INVALID_DEFAULT_VALUE'
  | 'UNKNOWN_PLACEMENT_KEY'
  | 'EMPTY_LABEL';

export type BlockConfigIssue = {
  readonly code: BlockConfigIssueCode;
  readonly blockKey: string;
  readonly propertyKey?: string;
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

export type BlockPropsValidationIssueCode = 'REQUIRED' | 'INVALID' | 'UNKNOWN';

export type BlockPropsValidationIssue = {
  readonly propertyKey: string;
  readonly code: BlockPropsValidationIssueCode;
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

function resolvePlacement(
  kind: BlockKind,
  placement: BlockPlacement | undefined,
): ResolvedBlockPlacement {
  const ownerTypes = placement?.ownerTypes ?? OWNER_TYPES;
  const allowedParents = placement?.allowedParents ?? 'any';
  const allowedChildren =
    placement?.allowedChildren ?? (kind === 'section' ? 'any' : 'none');
  return Object.freeze({
    ownerTypes: Object.freeze([...ownerTypes]),
    allowedParents:
      allowedParents === 'any' ? 'any' : Object.freeze([...allowedParents]),
    allowedChildren:
      allowedChildren === 'any' || allowedChildren === 'none'
        ? allowedChildren
        : Object.freeze([...allowedChildren]),
  });
}

function resolveProperty(
  property: BlockPropertyDefinition,
): BlockPropertyDefinition {
  // Resolvable here without a try/catch: an unresolvable fieldType already
  // failed validation and stopped this entry from reaching `toDefinition`.
  const fieldDefinition = getFieldTypeDefinition(property.fieldType);
  return Object.freeze({
    ...property,
    widget: property.widget ?? fieldDefinition.defaultWidget,
  });
}

function toDefinition(entry: BlockDefinitionInput): BlockDefinition {
  const kind = entry.kind ?? 'block';
  const properties: Record<string, BlockPropertyDefinition> = {};
  for (const [propertyKey, property] of Object.entries(entry.properties)) {
    properties[propertyKey] = resolveProperty(property);
  }
  return Object.freeze({
    key: entry.key,
    kind,
    editor: Object.freeze({ ...entry.editor }),
    properties: Object.freeze(properties),
    placement: resolvePlacement(kind, entry.placement),
    schemaVersion: entry.schemaVersion,
    upcasters: Object.freeze({ ...entry.upcasters }),
    ...(entry.minSupportedVersion !== undefined
      ? { minSupportedVersion: entry.minSupportedVersion }
      : {}),
    ...(entry.component !== undefined ? { component: entry.component } : {}),
    ...(entry.lintExempt !== undefined ? { lintExempt: entry.lintExempt } : {}),
  });
}

function validateUpcasters(
  entry: BlockDefinitionInput,
  issues: BlockConfigIssue[],
): void {
  const upcasters = entry.upcasters ?? {};
  const declaredSteps = Object.keys(upcasters).map(Number);

  for (const step of declaredSteps) {
    if (step < 2 || step > entry.schemaVersion) {
      issues.push({
        code: 'UPCASTER_OUT_OF_RANGE',
        blockKey: entry.key,
        message: `block "${entry.key}" upcasters step ${step} is outside the valid range 2..${entry.schemaVersion}`,
      });
    }
  }
  for (let step = 2; step <= entry.schemaVersion; step += 1) {
    if (!(step in upcasters)) {
      issues.push({
        code: 'UPCASTER_GAP',
        blockKey: entry.key,
        message: `block "${entry.key}" is missing an upcaster for step ${step} (schemaVersion ${entry.schemaVersion})`,
      });
    }
  }
}

function validateProperties(
  entry: BlockDefinitionInput,
  issues: BlockConfigIssue[],
): void {
  for (const [propertyKey, property] of Object.entries(entry.properties)) {
    if (!BLOCK_PROPERTY_KEY_PATTERN.test(propertyKey)) {
      issues.push({
        code: 'INVALID_PROPERTY_KEY',
        blockKey: entry.key,
        propertyKey,
        message: `block "${entry.key}" property key "${propertyKey}" must match ${BLOCK_PROPERTY_KEY_PATTERN.source}`,
      });
    }
    if (property.label.trim().length === 0) {
      issues.push({
        code: 'EMPTY_LABEL',
        blockKey: entry.key,
        propertyKey,
        message: `block "${entry.key}" property "${propertyKey}" must declare a non-empty label`,
      });
    }

    let fieldDefinition;
    try {
      fieldDefinition = getFieldTypeDefinition(property.fieldType);
    } catch {
      issues.push({
        code: 'UNKNOWN_FIELD_TYPE',
        blockKey: entry.key,
        propertyKey,
        message: `block "${entry.key}" property "${propertyKey}" has unknown field type "${property.fieldType}"`,
      });
      continue;
    }

    const optionsResult = fieldDefinition.optionsSchema.safeParse(
      property.options ?? {},
    );
    if (!optionsResult.success) {
      issues.push({
        code: 'INVALID_FIELD_OPTIONS',
        blockKey: entry.key,
        propertyKey,
        message: `block "${entry.key}" property "${propertyKey}" has invalid options: ${optionsResult.error.issues
          .map((issue) => issue.message)
          .join('; ')}`,
      });
      continue;
    }

    if (property.widget !== undefined) {
      const widgets = getFieldTypeWidgets(property.fieldType);
      if (!widgets.includes(property.widget)) {
        issues.push({
          code: 'UNKNOWN_WIDGET',
          blockKey: entry.key,
          propertyKey,
          message: `block "${entry.key}" property "${propertyKey}" widget "${property.widget}" is not one of ${widgets.join(', ')}`,
        });
      }
    }

    if (property.defaultValue !== undefined) {
      const valueSchema = fieldDefinition.buildValueSchema(optionsResult.data);
      const defaultResult = valueSchema.safeParse(property.defaultValue);
      if (!defaultResult.success) {
        issues.push({
          code: 'INVALID_DEFAULT_VALUE',
          blockKey: entry.key,
          propertyKey,
          message: `block "${entry.key}" property "${propertyKey}" defaultValue fails its field type's own value schema`,
        });
      }
    }
  }
}

function validatePlacementKeys(
  entry: BlockDefinitionInput,
  knownKeys: ReadonlySet<string>,
  issues: BlockConfigIssue[],
): void {
  const placement = entry.placement;
  if (placement === undefined) return;

  const checkKeys = (
    keys: readonly string[] | 'any' | 'none' | undefined,
    field: 'allowedParents' | 'allowedChildren',
  ): void => {
    if (keys === undefined || keys === 'any' || keys === 'none') return;
    for (const key of keys) {
      if (!knownKeys.has(key)) {
        issues.push({
          code: 'UNKNOWN_PLACEMENT_KEY',
          blockKey: entry.key,
          message: `block "${entry.key}" placement.${field} references unknown block key "${key}"`,
        });
      }
    }
  };

  checkKeys(placement.allowedParents, 'allowedParents');
  checkKeys(placement.allowedChildren, 'allowedChildren');
}

/**
 * Validates every block declaration and registers it (D-01, D-05, D-16).
 * Collects every problem across every entry -- never fails on the first
 * bad entry or the first bad field within one entry -- before throwing one
 * `BlockConfigError`. Registration itself is same-key re-registration, last
 * wins, by pure array order (D-05): `entries` is iterated in order into a
 * `Map`, so a later entry with the same `key` overwrites an earlier one.
 * Returns a frozen array of the map's values, and this same call populates
 * the module-level registry `getBlockDefinition`/`listBlockDefinitions`
 * read from.
 */
export function defineBlocks(
  entries: readonly BlockDefinitionInput[],
): readonly BlockDefinition[] {
  const issues: BlockConfigIssue[] = [];
  const knownKeys = new Set(entries.map((entry) => entry.key));

  for (const entry of entries) {
    if (!BLOCK_KEY_PATTERN.test(entry.key)) {
      issues.push({
        code: 'INVALID_KEY',
        blockKey: entry.key,
        message: `block key "${entry.key}" must match ${BLOCK_KEY_PATTERN.source}`,
      });
    }
    if (entry.editor.label.trim().length === 0) {
      issues.push({
        code: 'EMPTY_LABEL',
        blockKey: entry.key,
        message: `block "${entry.key}" must declare a non-empty editor.label`,
      });
    }
    if (!Number.isInteger(entry.schemaVersion) || entry.schemaVersion < 1) {
      issues.push({
        code: 'INVALID_SCHEMA_VERSION',
        blockKey: entry.key,
        message: `block "${entry.key}" schemaVersion must be an integer of at least 1`,
      });
    }
    if (
      entry.minSupportedVersion !== undefined &&
      (!Number.isInteger(entry.minSupportedVersion) ||
        entry.minSupportedVersion < 1 ||
        entry.minSupportedVersion > entry.schemaVersion)
    ) {
      issues.push({
        code: 'INVALID_MIN_SUPPORTED_VERSION',
        blockKey: entry.key,
        message: `block "${entry.key}" minSupportedVersion must be an integer between 1 and schemaVersion (${entry.schemaVersion})`,
      });
    }

    validateUpcasters(entry, issues);
    validateProperties(entry, issues);
    validatePlacementKeys(entry, knownKeys, issues);
  }

  if (issues.length > 0) {
    throw new BlockConfigError(issues);
  }

  const byKey = new Map<string, BlockDefinition>();
  for (const entry of entries) {
    byKey.set(entry.key, toDefinition(entry));
  }

  registry.clear();
  for (const [key, definition] of byKey) {
    registry.set(key, definition);
  }

  return Object.freeze([...byKey.values()]);
}

/**
 * Replaces the module-level registry wholesale with an already-resolved set
 * of definitions -- called by `definePagesConfig` (config.ts) once
 * `applyBlockConstraints` has attached each block's resolved `constraints`
 * map, so `getBlockDefinition` (and everything that reads through it:
 * `insertBlock`, `updateBlockProps`, `moveBlock`, `buildPageSnapshot`, ...)
 * resolves the SAME constrained definitions `definePagesConfig` returns as
 * `PagesConfig.blocks` -- never the unconstrained set `defineBlocks` first
 * registered. Whole-registry replacement, not a merge, mirrors `defineBlocks`
 * itself (D-05): `definePagesConfig` is meant to be the one authoritative
 * call composing a host's real config, so calling it again (a host's own
 * config module re-evaluated, or a test process building a fresh config
 * per test) simply replaces the registry again -- the same last-call-wins
 * semantics `defineBlocks` already has, not a new source of drift. Not part
 * of this package's public barrel: a caller reaching this directly could
 * desync the registry from a `PagesConfig` no one holds anymore.
 */
export function registerResolvedBlocks(
  definitions: readonly BlockDefinition[],
): void {
  registry.clear();
  for (const definition of definitions) {
    registry.set(definition.key, definition);
  }
}

/** Reads a block's definition by its `block_type`/key, from the
 * module-level registry `defineBlocks` populates and `definePagesConfig`
 * (config.ts) then re-populates with each block's resolved constraints
 * (`registerResolvedBlocks`, D-04). Throws `UnknownBlockTypeError` when
 * absent. */
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

/** A property as resolved for the editor/write path: the declaration plus
 * the `constraint` discriminant a caller uses to tell hidden, fixed,
 * narrowed and unconstrained apart -- never by absence alone (D-04). */
export type ResolvedBlockProperty = BlockPropertyDefinition & {
  readonly constraint: 'hidden' | 'fixed' | 'narrowed' | 'none';
  readonly fixedValue?: unknown;
  readonly allowedValues?: readonly string[];
};

/**
 * The single function the editor, the property-panel builder and
 * `validateBlockProps` all read to know a block's real, currently
 * applicable property map -- so a constraint (`constrainBlock`/
 * `applyBlockConstraints`, constraints.ts) can never be visible in one place
 * and absent in another. A `hidden` property is omitted entirely: the
 * declaration still knows it exists (`definition.properties` is untouched),
 * but nothing reading only this map ever sees it. `fixed` and `narrowed`
 * properties stay present with their `constraint` discriminant set and their
 * resolved value/choices attached.
 */
export function resolveBlockProperties(
  definition: BlockDefinition,
): Readonly<Record<string, ResolvedBlockProperty>> {
  const resolved: Record<string, ResolvedBlockProperty> = {};
  for (const [propertyKey, property] of Object.entries(definition.properties)) {
    const propertyConstraint = definition.constraints?.[propertyKey];
    if (propertyConstraint === undefined) {
      resolved[propertyKey] = Object.freeze({
        ...property,
        constraint: 'none',
      });
      continue;
    }
    if (propertyConstraint.kind === 'hidden') {
      continue;
    }
    if (propertyConstraint.kind === 'fixed') {
      resolved[propertyKey] = Object.freeze({
        ...property,
        constraint: 'fixed',
        fixedValue: propertyConstraint.value,
      });
      continue;
    }
    resolved[propertyKey] = Object.freeze({
      ...property,
      constraint: 'narrowed',
      allowedValues: propertyConstraint.allowedValues,
    });
  }
  return Object.freeze(resolved);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A `fixed` property accepts only its own fixed value (omitted input is
 * treated as that value); anything else is `INVALID`. Fixed values are
 * always JSON-serialisable (they already passed the property's own field
 * type's value schema in `applyBlockConstraints`), so a structural
 * `JSON.stringify` comparison is exact and avoids re-implementing a
 * field-type-aware deep-equal here. */
function equalsFixedValue(candidate: unknown, fixedValue: unknown): boolean {
  return JSON.stringify(candidate) === JSON.stringify(fixedValue);
}

/** A `narrowed` property's submitted value must be drawn from
 * `allowedValues` -- checked generically as "every string in the submitted
 * value (a single string for `select`, an array for `multi_select`) is one
 * of the allowed choice values" so this stays field-type-agnostic rather
 * than special-casing `select`/`multi_select`'s own shapes. */
function withinAllowedValues(
  candidate: unknown,
  allowedValues: readonly string[],
): boolean {
  const allowed = new Set(allowedValues);
  const values = Array.isArray(candidate) ? candidate : [candidate];
  return values.every(
    (value) => typeof value === 'string' && allowed.has(value),
  );
}

/**
 * Validates a block instance's `props` against `resolveBlockProperties`
 * (T-04-01, T-04-22), reusing `@plakboek/content`'s field-type registry
 * (D-03): one validation engine serves both content fields and block props,
 * and every constraint (`hidden`/`fixed`/`narrowed`) is enforced here too --
 * never only in the editor. Collects every issue before throwing one
 * `BlockPropsValidationError`, naming only the property key and issue code,
 * never the submitted value. Returns the validated, parsed props object.
 * A key not among the resolved (non-hidden) properties -- including a
 * `hidden` property's own key -- is rejected as `UNKNOWN`, never silently
 * dropped: a hidden property can never be reached through this door either.
 */
export function validateBlockProps(
  definition: BlockDefinition,
  props: unknown,
): Record<string, unknown> {
  const input = isPlainObject(props) ? props : {};
  const resolved = resolveBlockProperties(definition);
  const issues: BlockPropsValidationIssue[] = [];
  const validated: Record<string, unknown> = {};

  for (const key of Object.keys(input)) {
    if (!(key in resolved)) {
      issues.push({ propertyKey: key, code: 'UNKNOWN' });
    }
  }

  for (const [propertyKey, property] of Object.entries(resolved)) {
    const value: unknown = input[propertyKey];

    if (property.constraint === 'fixed') {
      const candidate = value === undefined ? property.fixedValue : value;
      if (!equalsFixedValue(candidate, property.fixedValue)) {
        issues.push({ propertyKey, code: 'INVALID' });
        continue;
      }
      validated[propertyKey] = property.fixedValue;
      continue;
    }

    const fieldDefinition = getFieldTypeDefinition(property.fieldType);

    if (property.required === true && fieldDefinition.isEmptyValue(value)) {
      issues.push({ propertyKey, code: 'REQUIRED' });
      continue;
    }
    if (fieldDefinition.isEmptyValue(value)) {
      continue;
    }

    const optionsResult = fieldDefinition.optionsSchema.safeParse(
      property.options ?? {},
    );
    const options = optionsResult.success
      ? optionsResult.data
      : (property.options ?? {});
    const result = fieldDefinition.buildValueSchema(options).safeParse(value);
    if (!result.success) {
      issues.push({ propertyKey, code: 'INVALID' });
      continue;
    }
    if (
      property.constraint === 'narrowed' &&
      property.allowedValues !== undefined &&
      !withinAllowedValues(result.data, property.allowedValues)
    ) {
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
