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

/** The toggles of the marks group, in the order they are drawn. */
export type ToggleId = 'bold';

export type ToggleControl = {
  readonly id: ToggleId;
  readonly pressed: boolean;
};

export type ToolbarModel = {
  readonly marks: readonly ToggleControl[];
};

export type ToolbarInput = {
  readonly theme: TextTheme;
  /** The editor's `isActive`: whether a mark or node applies at the selection. */
  readonly isActive: (
    name: string,
    attributes?: Readonly<Record<string, unknown>>,
  ) => boolean;
};

const MARKS: readonly ToggleId[] = ['bold'];

export function toolbarModel(input: ToolbarInput): ToolbarModel {
  const { theme, isActive } = input;
  return {
    marks: MARKS.filter((id) => theme.marks.includes(id)).map((id) => ({
      id,
      pressed: isActive(id),
    })),
  };
}
