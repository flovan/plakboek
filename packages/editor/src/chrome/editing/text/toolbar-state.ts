/**
 * What the rich text toolbar shows, worked out from the field's effective text
 * theme and the editor's state. Pure data, so it is proven in Node: the
 * toolbar component only draws it.
 *
 * A control the theme does not allow is not in the model at all (and its mark
 * or node is not in the field's schema either), so the toolbar never offers
 * what the server would refuse. Later plans add their own control here (the
 * Insert menu, the Custom style toggle, Link); a control is never listed
 * before it works.
 */
import type { TextTheme } from '@plakboek/content/rich-text';
import {
  STYLE_LEVEL,
  type HeadingStyleId,
} from '../../../client/text/heading-styles.js';
import { insertItems } from '../../../client/text/insert-items.js';

export { STYLE_LEVEL };

/** The text styles of the menu, in the order they are listed. */
export type StyleId = 'paragraph' | 'title' | 'heading' | 'subheading';

const STYLES: readonly HeadingStyleId[] = ['title', 'heading', 'subheading'];

/** The toggles of the marks and lists groups, in the order they are drawn. */
export type ToggleId =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'bulletList'
  | 'orderedList';

export type ToggleControl = {
  readonly id: ToggleId;
  readonly pressed: boolean;
};

export type StyleControl = {
  /** The style at the selection, as the button shows it. */
  readonly current: StyleId;
  /** The rows of the menu: Paragraph, then each heading style the theme allows. */
  readonly options: readonly StyleId[];
};

export type ToolbarModel = {
  /** Absent when the theme allows paragraphs only. */
  readonly style: StyleControl | null;
  readonly marks: readonly ToggleControl[];
  readonly lists: readonly ToggleControl[];
  /** Whether the Insert menu has anything to offer; absent from the bar when not. */
  readonly insert: boolean;
};

export type ToolbarInput = {
  readonly theme: TextTheme;
  /** The editor's `isActive`: whether a mark or node applies at the selection. */
  readonly isActive: (
    name: string,
    attributes?: Readonly<Record<string, unknown>>,
  ) => boolean;
};

const MARKS = ['bold', 'italic', 'underline', 'strike'] as const;
const LISTS = ['bulletList', 'orderedList'] as const;

export function toolbarModel(input: ToolbarInput): ToolbarModel {
  const { theme, isActive } = input;
  const allowed = STYLES.filter((style) =>
    theme.headingLevels.includes(STYLE_LEVEL[style]),
  );
  const current: StyleId =
    allowed.find((style) =>
      isActive('heading', { level: STYLE_LEVEL[style] }),
    ) ?? 'paragraph';
  return {
    style:
      allowed.length === 0
        ? null
        : { current, options: ['paragraph', ...allowed] },
    marks: MARKS.filter((id) => theme.marks.includes(id)).map((id) => ({
      id,
      pressed: isActive(id),
    })),
    lists: LISTS.filter((id) => theme.nodes.includes(id)).map((id) => ({
      id,
      pressed: isActive(id),
    })),
    insert: insertItems(theme, 'plus').length > 0,
  };
}

/** What changed between two models of one field, in the order it is announced. */
export type ToolbarChange =
  | { readonly kind: 'toggle'; readonly id: ToggleId; readonly on: boolean }
  | { readonly kind: 'style'; readonly style: StyleId };

/**
 * The toggles that went on or off and the style that changed, so a screen
 * reader hears "Bold on." or "Heading." whether the change came from a button,
 * a shortcut or anything else that edits the field.
 */
export function toolbarChanges(
  before: ToolbarModel,
  after: ToolbarModel,
): readonly ToolbarChange[] {
  const changes: ToolbarChange[] = [];
  if (
    before.style !== null &&
    after.style !== null &&
    before.style.current !== after.style.current
  ) {
    changes.push({ kind: 'style', style: after.style.current });
  }
  const was = new Map(
    [...before.marks, ...before.lists].map((toggle) => [
      toggle.id,
      toggle.pressed,
    ]),
  );
  for (const toggle of [...after.marks, ...after.lists]) {
    const previous = was.get(toggle.id);
    if (previous !== undefined && previous !== toggle.pressed) {
      changes.push({ kind: 'toggle', id: toggle.id, on: toggle.pressed });
    }
  }
  return changes;
}
