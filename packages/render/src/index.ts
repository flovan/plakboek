/**
 * Root entry for @plakboek/render: the block-authoring contract.
 *
 * Safe to import from any bundle, including the editor and every block
 * module. It imports no `react-dom/server`, no `drizzle-orm`, no
 * `@plakboek/pages` value and no `node:` builtin; everything server-side
 * lives behind `@plakboek/render/server`.
 */

// constants
export {
  CMS_LOGIN_PATH,
  EDIT_PARAM,
  EDITOR_FLAG_KEY,
  NEXT_PARAM,
  TOOLBAR_DISMISSED_KEY,
} from './constants.js';

// block-component
export type {
  BlockComponent,
  BlockComponentProps,
  BlockIdentity,
} from './block-component.js';

// layout
export type { BlockLayout, ColumnAlign } from './layout.js';

// columns
export { Columns, columnTracks } from './columns.js';
export type { ColumnsProps } from './columns.js';

// column-block
export { ColumnBlock } from './column-block.js';

// edit-hooks
export { defineBlockEdit } from './edit-hooks.js';
export type {
  BlockEditContext,
  BlockEditHooks,
  BlockEditMode,
  BlockEditModule,
  BlockRevealContext,
} from './edit-hooks.js';

// head
export type {
  DocumentInput,
  DocumentMode,
  PageHead,
  RenderDocument,
} from './head.js';

// edit-proxy
export { NOOP_EDIT } from './edit-proxy.js';
export type { EditAttributes, EditProxy } from './edit-proxy.js';

// live-edit
export { EDIT_ATTRIBUTE, isLiveEdit } from './live-edit.js';

// rich-text
export { DEFAULT_TEXT_RENDERERS } from './rich-text/renderers.js';
export type {
  BlockquoteRendererProps,
  BoldRendererProps,
  BulletListRendererProps,
  CtaRendererProps,
  CtaRowRendererProps,
  HardBreakRendererProps,
  HeadingRendererProps,
  HorizontalRuleRendererProps,
  ItalicRendererProps,
  LinkRendererProps,
  ListItemRendererProps,
  OrderedListRendererProps,
  ParagraphRendererProps,
  StrikeRendererProps,
  TextColorRendererProps,
  TextRenderers,
  TextSizeRendererProps,
  UnderlineRendererProps,
} from './rich-text/renderers.js';
export {
  defineTextTheme,
  isTextThemeDefinition,
} from './rich-text/define-text-theme.js';
export type {
  LinkTarget,
  TextTheme,
  TextThemeDefinition,
  TextThemeDefinitionInput,
  TextThemeInput,
  TextThemeNarrowing,
} from './rich-text/define-text-theme.js';
export {
  createTextEnvironment,
  TextEnvironmentProvider,
  useTextEnvironment,
} from './rich-text/environment.js';
export type {
  TextEnvironment,
  TextEnvironmentInput,
  TextEnvironmentMode,
} from './rich-text/environment.js';
export { RichText } from './rich-text/rich-text.js';
export type { RichTextProps } from './rich-text/rich-text.js';
export { CtaButton } from './rich-text/cta.js';
export type { CtaButtonProps } from './rich-text/cta.js';
