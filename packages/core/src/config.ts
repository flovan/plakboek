/**
 * `defineConfig`: the validated, code-only source of every structural
 * setting. There is no settings table and no runtime toggle: blocks, modules,
 * rules (block constraints, section nesting depth, block depth ceiling),
 * roles, locales, site name and menus are all declared here and checked when
 * the config is evaluated, so a bad config fails the process at start.
 *
 * Evaluation order: this module's own collect-then-throw checks (site name,
 * menus, module names, seed shape) raise one `PlakboekConfigError` before any
 * engine call; then the engines run in turn (`defineContentConfig`, host field
 * types and widgets, `defineBlocks`, `definePagesConfig`, `defineRoles`) and
 * each engine's own error class propagates unchanged; finally the seed is
 * checked against the registered blocks.
 *
 * Dev reload: every evaluation replaces the process-wide block registry (the
 * last call wins) and returns its own frozen object. That is why the runtime
 * keys its handlers by config object identity: a reloaded config builds a new
 * handler and never reuses one holding an old block set. Evaluating the same
 * input twice is a no-op in effect.
 *
 * Server-side only; a block file imports `defineBlock` from the package root
 * instead.
 */
import {
  defineContentConfig,
  registerHostFieldType,
  registerHostWidget,
} from '@plakboek/content';
import { defaultRoles, defineRoles } from '@plakboek/permissions';
import {
  DEFAULT_HOME_SLUG,
  defineBlocks,
  definePagesConfig,
} from '@plakboek/pages';
import { validateMenus } from './menus.js';
import { MODULE_NAME_PATTERN } from './modules.js';
import type {
  HostBlockDefinition,
  MenuDefinitions,
  ModuleDefinition,
  PlakboekConfig,
  PlakboekConfigInput,
  SeedPage,
} from './types.js';

export type PlakboekConfigIssueCode =
  | 'INVALID_SITE_NAME'
  | 'INVALID_MENU'
  | 'INVALID_MENU_ITEM'
  | 'INVALID_MODULE'
  | 'DUPLICATE_MODULE'
  | 'INVALID_SEED'
  | 'UNKNOWN_SEED_BLOCK'
  | 'SEED_ROOT_NOT_SECTION';

export type PlakboekConfigIssue = {
  readonly code: PlakboekConfigIssueCode;
  readonly message: string;
};

/** Thrown by `defineConfig` with every problem found, collected first. */
export class PlakboekConfigError extends Error {
  readonly issues: readonly PlakboekConfigIssue[];

  constructor(issues: readonly PlakboekConfigIssue[]) {
    super(
      [
        '[@plakboek/core] invalid config:',
        ...issues.map((issue) => `${issue.code}: ${issue.message}`),
      ].join('\n'),
    );
    this.name = 'PlakboekConfigError';
    this.issues = issues;
  }
}

export { defaultRoles };

const SITE_NAME_MAX_LENGTH = 200;
const SEED_TITLE_MAX_LENGTH = 200;
const SEED_MAX_DEPTH = 32;
const ECHO_LIMIT = 64;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A short, printable form of a developer-supplied string for a message. */
function echo(value: string): string {
  const printable = value.replace(/[^\x20-\x7e]/g, '?');
  return printable.length > ECHO_LIMIT
    ? `${printable.slice(0, ECHO_LIMIT)}...`
    : printable;
}

function checkSiteName(siteName: unknown, issues: PlakboekConfigIssue[]): void {
  const problem =
    typeof siteName !== 'string' || siteName.trim().length === 0
      ? 'siteName must be a non-blank string'
      : siteName.length > SITE_NAME_MAX_LENGTH
        ? `siteName must be at most ${SITE_NAME_MAX_LENGTH} characters`
        : hasControlCharacter(siteName)
          ? 'siteName must not contain control characters'
          : null;
  if (problem !== null) {
    issues.push({ code: 'INVALID_SITE_NAME', message: problem });
  }
}

function checkModules(modules: unknown, issues: PlakboekConfigIssue[]): void {
  if (modules === undefined) return;
  if (!Array.isArray(modules)) {
    issues.push({
      code: 'INVALID_MODULE',
      message: 'modules must be an array of defineModule(...) results',
    });
    return;
  }

  const seen = new Set<string>();
  modules.forEach((entry: unknown, index) => {
    const where = `modules[${index}]`;
    if (!isRecord(entry) || typeof entry.name !== 'string') {
      issues.push({
        code: 'INVALID_MODULE',
        message: `${where}: a module needs a string name`,
      });
      return;
    }
    if (!MODULE_NAME_PATTERN.test(entry.name)) {
      issues.push({
        code: 'INVALID_MODULE',
        message: `${where}: module name "${echo(entry.name)}" must match ${MODULE_NAME_PATTERN.source}`,
      });
      return;
    }
    if (seen.has(entry.name)) {
      issues.push({
        code: 'DUPLICATE_MODULE',
        message: `${where}: module name "${entry.name}" is declared more than once`,
      });
    }
    seen.add(entry.name);

    for (const field of [
      'blocks',
      'fieldTypes',
      'widgets',
      'constraints',
    ] as const) {
      const value = entry[field];
      if (value !== undefined && !Array.isArray(value)) {
        issues.push({
          code: 'INVALID_MODULE',
          message: `${where}: ${field} must be an array when present`,
        });
      }
    }
  });
}

function checkSeedNodes(
  nodes: unknown,
  path: string,
  depth: number,
  issues: PlakboekConfigIssue[],
): void {
  if (!Array.isArray(nodes)) {
    issues.push({
      code: 'INVALID_SEED',
      message: `${path} must be an array of blocks`,
    });
    return;
  }
  if (depth > SEED_MAX_DEPTH) {
    issues.push({
      code: 'INVALID_SEED',
      message: `${path} is nested deeper than ${SEED_MAX_DEPTH} levels`,
    });
    return;
  }
  nodes.forEach((node: unknown, index) => {
    const where = `${path}[${index}]`;
    if (!isRecord(node) || typeof node.type !== 'string') {
      issues.push({
        code: 'INVALID_SEED',
        message: `${where} must be an object with a string type`,
      });
      return;
    }
    if (node.props !== undefined && !isRecord(node.props)) {
      issues.push({
        code: 'INVALID_SEED',
        message: `${where}.props must be a plain object when present`,
      });
    }
    if (node.children !== undefined) {
      checkSeedNodes(node.children, `${where}.children`, depth + 1, issues);
    }
  });
}

function checkSeedShape(seed: unknown, issues: PlakboekConfigIssue[]): void {
  if (!isRecord(seed)) {
    issues.push({
      code: 'INVALID_SEED',
      message: 'seed must be a page object with a title and blocks',
    });
    return;
  }
  if (
    typeof seed.title !== 'string' ||
    seed.title.trim().length === 0 ||
    seed.title.length > SEED_TITLE_MAX_LENGTH
  ) {
    issues.push({
      code: 'INVALID_SEED',
      message: `seed.title must be a string of 1 to ${SEED_TITLE_MAX_LENGTH} characters`,
    });
  }
  checkSeedNodes(seed.blocks, 'seed.blocks', 0, issues);
}

function checkSeedBlocks(
  seed: SeedPage,
  kinds: ReadonlyMap<string, string>,
): PlakboekConfigIssue[] {
  const issues: PlakboekConfigIssue[] = [];
  const walk = (
    nodes: SeedPage['blocks'],
    path: string,
    isRoot: boolean,
  ): void => {
    nodes.forEach((node, index) => {
      const where = `${path}[${index}]`;
      const kind = kinds.get(node.type);
      if (kind === undefined) {
        issues.push({
          code: 'UNKNOWN_SEED_BLOCK',
          message: `${where}: block type "${echo(node.type)}" is not registered`,
        });
      } else if (isRoot && kind !== 'section') {
        issues.push({
          code: 'SEED_ROOT_NOT_SECTION',
          message: `${where}: root block "${node.type}" must be a section`,
        });
      }
      if (node.children !== undefined) {
        walk(node.children, `${where}.children`, false);
      }
    });
  };
  walk(seed.blocks, 'seed.blocks', true);
  return issues;
}

function freezeMenus(menus: MenuDefinitions | undefined): MenuDefinitions {
  const frozen: Record<string, MenuDefinitions[string]> = {};
  for (const [name, items] of Object.entries(menus ?? {})) {
    frozen[name] = Object.freeze(
      items.map((item) =>
        Object.freeze({
          label:
            typeof item.label === 'string'
              ? item.label
              : Object.freeze({ ...item.label }),
          href: item.href,
        }),
      ),
    );
  }
  return Object.freeze(frozen);
}

/** Contributions of every module, in module array order. */
function fromModules<T>(
  modules: readonly ModuleDefinition[],
  pick: (module: ModuleDefinition) => readonly T[] | undefined,
): T[] {
  return modules.flatMap((module) => pick(module) ?? []);
}

export function defineConfig(input: PlakboekConfigInput): PlakboekConfig {
  const issues: PlakboekConfigIssue[] = [];
  checkSiteName(input.siteName, issues);
  issues.push(...validateMenus(input.menus));
  checkModules(input.modules, issues);

  const seedInput =
    input.seed === undefined
      ? null
      : typeof input.seed === 'function'
        ? input.seed()
        : input.seed;
  if (seedInput !== null) checkSeedShape(seedInput, issues);

  if (issues.length > 0) throw new PlakboekConfigError(issues);

  const modules = input.modules ?? [];
  const blocks: HostBlockDefinition[] = [
    ...fromModules(modules, (m) => m.blocks),
    ...input.blocks,
  ];
  const fieldTypes = [
    ...fromModules(modules, (m) => m.fieldTypes),
    ...(input.fieldTypes ?? []),
  ];
  const widgets = [
    ...fromModules(modules, (m) => m.widgets),
    ...(input.widgets ?? []),
  ];
  const constraints = [
    ...fromModules(modules, (m) => m.constraints),
    ...(input.constraints ?? []),
  ];

  const content = defineContentConfig({
    locales: input.locales,
    defaultLocale: input.defaultLocale,
    timezone: input.timezone,
  });

  // Host field types and widgets are registered here, ahead of `defineBlocks`:
  // a block property may name a host field type, and `defineBlocks` resolves
  // it at declaration time. `definePagesConfig` is not handed them again, so
  // the shadowed-field-type hook fires once.
  registerHostFieldType(fieldTypes, {
    onShadowedFieldType: input.hooks?.onShadowedFieldType,
  });
  registerHostWidget(widgets);

  const pages = definePagesConfig({
    content,
    blocks: defineBlocks(blocks),
    constraints,
    ...(input.sectionNestingDepth === undefined
      ? {}
      : { sectionNestingDepth: input.sectionNestingDepth }),
    ...(input.blockDepthCeiling === undefined
      ? {}
      : { blockDepthCeiling: input.blockDepthCeiling }),
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
  });
  const roles = defineRoles(input.roles ?? defaultRoles);

  if (seedInput !== null) {
    const kinds = new Map(pages.blocks.map((block) => [block.key, block.kind]));
    const seedIssues = checkSeedBlocks(seedInput, kinds);
    if (seedIssues.length > 0) throw new PlakboekConfigError(seedIssues);
  }

  return Object.freeze({
    siteName: input.siteName,
    content,
    pages,
    roles,
    menus: freezeMenus(input.menus),
    modules: Object.freeze(modules.map((module) => module.name)),
    seed: seedInput,
    homeSlug: DEFAULT_HOME_SLUG,
  });
}
