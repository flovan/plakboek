/**
 * The boot-time layout-only lint for sections (BLOCK-05, D-17, 01 D-15):
 * "a section exposes layout properties only" has no closed vocabulary (the
 * plan's own flagged assumption), so this module never blocks a write or a
 * boot -- it names a content-ish property on a section, through the
 * injectable warning hook, so a host can see and deliberately ignore it. A
 * section carrying `lintExempt: true` opts out of the content findings, but
 * that opt-out itself is reported once, so it stays visible rather than
 * silently suppressing the lint.
 */
import type { PagesHooks } from './config.js';
import { resolveBlockProperties, type BlockDefinition } from './registry.js';
import { reportPagesWarning } from './warnings.js';

/** Exactly D-17's four flagged field types. Each is asserted (by this
 * module's own unit test) to be a member of `FIELD_TYPES`, so a future
 * rename of a field type cannot leave a dead entry here unnoticed. */
export const SECTION_LINT_FIELD_TYPES = Object.freeze([
  'rich_text',
  'reference',
  'repeater',
  'long_text',
] as const);

/** Exactly D-17's six flagged property-name substrings, matched
 * case-insensitively against a property's key. */
export const SECTION_LINT_PROPERTY_SUBSTRINGS = Object.freeze([
  'title',
  'heading',
  'body',
  'text',
  'label',
  'cta',
] as const);

export type SectionLintReason =
  | 'content-field-type'
  | 'content-property-name'
  | 'exempt';

export type SectionLintFinding = {
  readonly blockKey: string;
  readonly propertyKey?: string;
  readonly reason: SectionLintReason;
  readonly detail: string;
};

/** Emitted by `reportSectionLint` -- never thrown. Carries every finding
 * from one `lintSectionProperties` pass, so a host's hook sees the whole
 * boot-time picture in one call rather than one call per finding. */
export type SectionLintEvent = {
  readonly findings: readonly SectionLintFinding[];
  readonly occurredAt: Date;
};

function matchesFlaggedSubstring(propertyKey: string): boolean {
  const lowered = propertyKey.toLowerCase();
  return SECTION_LINT_PROPERTY_SUBSTRINGS.some((substring) =>
    lowered.includes(substring),
  );
}

/**
 * Pure: for every `kind: 'section'` definition, either emits one `exempt`
 * finding (when `lintExempt` is true, and nothing else -- the opt-out is
 * visible, but no content finding is produced for it) or walks
 * `resolveBlockProperties` and emits a `content-field-type` finding for
 * every property whose `fieldType` is one of `SECTION_LINT_FIELD_TYPES` and
 * a `content-property-name` finding for every property whose lowercased key
 * contains one of `SECTION_LINT_PROPERTY_SUBSTRINGS`. A property matching
 * both emits both findings -- neither reason hides the other. A non-section
 * block is never inspected. Findings are ordered by block key then property
 * key (properties without a key -- the `exempt` finding -- sort first
 * within a block) so the output is deterministic.
 */
export function lintSectionProperties(
  definitions: readonly BlockDefinition[],
): readonly SectionLintFinding[] {
  const findings: SectionLintFinding[] = [];

  for (const definition of definitions) {
    if (definition.kind !== 'section') continue;

    if (definition.lintExempt === true) {
      findings.push({
        blockKey: definition.key,
        reason: 'exempt',
        detail: `section "${definition.key}" opts out of the layout-only lint (lintExempt: true)`,
      });
      continue;
    }

    const resolved = resolveBlockProperties(definition);
    const propertyKeys = Object.keys(resolved).sort((a, b) =>
      a.localeCompare(b),
    );

    for (const propertyKey of propertyKeys) {
      const property = resolved[propertyKey];
      if (property === undefined) continue;

      if (
        (SECTION_LINT_FIELD_TYPES as readonly string[]).includes(
          property.fieldType,
        )
      ) {
        findings.push({
          blockKey: definition.key,
          propertyKey,
          reason: 'content-field-type',
          detail: `section "${definition.key}" property "${propertyKey}" declares a content field type ("${property.fieldType}"); sections are meant to expose layout properties only`,
        });
      }

      if (matchesFlaggedSubstring(propertyKey)) {
        findings.push({
          blockKey: definition.key,
          propertyKey,
          reason: 'content-property-name',
          detail: `section "${definition.key}" property "${propertyKey}" looks content-ish by name; sections are meant to expose layout properties only`,
        });
      }
    }
  }

  return Object.freeze(findings);
}

function defaultOnSectionLint(event: SectionLintEvent): void {
  const lines = event.findings.map((finding) =>
    finding.propertyKey === undefined
      ? `  - ${finding.blockKey}: ${finding.reason} -- ${finding.detail}`
      : `  - ${finding.blockKey}.${finding.propertyKey}: ${finding.reason} -- ${finding.detail}`,
  );
  // oxlint-disable-next-line no-console -- documented default fallback hook (D-17); a host overrides deps.hooks.onSectionLint to route elsewhere
  console.warn(
    ['[@plakboek/pages] section layout-only lint findings:', ...lines].join(
      '\n',
    ),
  );
}

/**
 * Reports every `lintSectionProperties` finding through
 * `hooks?.onSectionLint` (or the console-warning default) -- returns
 * immediately, calling nothing, when `findings` is empty. There is no
 * throwing path anywhere in this module and no code path that refuses a
 * write: a host may keep a flagged property deliberately, and this lint's
 * job is to make that visible, not to overrule it.
 */
export function reportSectionLint(
  hooks: PagesHooks | undefined,
  findings: readonly SectionLintFinding[],
  now: () => Date,
): void {
  if (findings.length === 0) return;
  reportPagesWarning(hooks?.onSectionLint, defaultOnSectionLint, {
    findings,
    occurredAt: now(),
  });
}
