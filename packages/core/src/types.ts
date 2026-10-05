/**
 * The host-facing type contracts of @plakboek/core. Type-only imports from
 * the engine packages, so this module (and the package root that re-exports
 * it) pulls in no runtime code.
 */
import type {
  BlockConstraintSet,
  BlockDefinitionInput,
  PagesConfig,
  PagesHooks,
} from '@plakboek/pages';
import type {
  HostFieldTypeDefinition,
  HostWidgetDefinition,
  ContentConfig,
} from '@plakboek/content';
import type { DefinedRoles, RoleConfig } from '@plakboek/permissions';
import type { BlockComponent, DocumentInput } from '@plakboek/render';
import type { EditEntrypoint } from '@plakboek/render/server';

/** A menu label: one string, or a record keyed by locale. */
export type MenuLabel = string | Readonly<Record<string, string>>;

export type MenuItem = {
  readonly label: MenuLabel;
  readonly href: string;
};

/** Menus by name, in code. */
export type MenuDefinitions = Readonly<Record<string, readonly MenuItem[]>>;

/** A menu item resolved for one locale and one current path. */
export type ResolvedMenuItem = {
  readonly label: string;
  readonly href: string;
  readonly current: boolean;
};

/** One block of a seed page; `type` is a block key. */
export type SeedBlock = {
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly children?: readonly SeedBlock[];
};

/** The page a fresh installation is seeded with; always published as `home`. */
export type SeedPage = {
  readonly title: string;
  readonly blocks: readonly SeedBlock[];
};

/**
 * A block definition with its render component. The component type is erased
 * to `BlockComponent<never>` in the configuration's block list so a block
 * with typed props is assignable without `any`.
 */
export type HostBlockDefinition<P = never> = Omit<
  BlockDefinitionInput,
  'component'
> & {
  readonly component: BlockComponent<P>;
};

/** A named bundle of blocks, field types, widgets and constraints. */
export type ModuleDefinition = {
  readonly name: string;
  readonly blocks?: readonly HostBlockDefinition[];
  readonly fieldTypes?: readonly HostFieldTypeDefinition[];
  readonly widgets?: readonly HostWidgetDefinition[];
  readonly constraints?: readonly BlockConstraintSet[];
};

export type PlakboekConfigInput = {
  readonly siteName: string;
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly timezone: string;
  readonly blocks: readonly HostBlockDefinition[];
  readonly roles?: RoleConfig;
  readonly menus?: MenuDefinitions;
  readonly modules?: readonly ModuleDefinition[];
  readonly constraints?: readonly BlockConstraintSet[];
  readonly fieldTypes?: readonly HostFieldTypeDefinition[];
  readonly widgets?: readonly HostWidgetDefinition[];
  readonly sectionNestingDepth?: number;
  readonly blockDepthCeiling?: number;
  readonly seed?: SeedPage | (() => SeedPage);
  readonly hooks?: PagesHooks;
};

/** The frozen, validated configuration `defineConfig` returns. */
export type PlakboekConfig = {
  readonly siteName: string;
  readonly content: ContentConfig;
  readonly pages: PagesConfig;
  readonly roles: DefinedRoles;
  readonly menus: MenuDefinitions;
  /** Module names, in the order they were merged. */
  readonly modules: readonly string[];
  readonly seed: SeedPage | null;
  readonly homeSlug: string;
};

/** What a site module receives alongside the page it composes. */
export type SiteContext = {
  readonly siteName: string;
  readonly locale: string;
  readonly defaultLocale: string;
  /** The canonical visitor path, or `null` where there is none (an error page). */
  readonly publicPath: string | null;
  getMenu(name: string): Promise<readonly ResolvedMenuItem[]>;
};

/** The host's site chrome: the document around every page. */
export type SiteModule = {
  renderDocument(
    input: DocumentInput,
    site: SiteContext,
  ): string | Promise<string>;
  renderNotFound?(
    request: Request,
    site: SiteContext,
  ): string | Promise<string>;
  renderError?(request: Request, site: SiteContext): string | Promise<string>;
};

/** What the virtual host module resolves to. */
export type HostModule = {
  readonly config: PlakboekConfig;
  readonly site?: SiteModule | undefined;
  readonly edit?: EditEntrypoint | undefined;
};
