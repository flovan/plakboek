import type { Command, EditorState } from '@tiptap/pm/state';
import type { TextAlign } from '@plakboek/content/rich-text';

export type TextStyleChoice = { token: string } | { value: string };

export type CustomStyle = {
  color: string | null;
  size: string | null;
  align: TextAlign | null;
};

const unavailable: Command = () => false;

export const setTextColor = (_choice: TextStyleChoice): Command => unavailable;
export const setTextSize = (_choice: TextStyleChoice): Command => unavailable;
export const clearTextColor: Command = unavailable;
export const clearTextSize: Command = unavailable;
export const setTextAlign = (_align: TextAlign | null): Command => unavailable;
export const resetStyle: Command = unavailable;
export const hasCustomStyle = (_state: EditorState): boolean => false;
export const currentCustomStyle = (_state: EditorState): CustomStyle => ({
  color: null,
  size: null,
  align: null,
});
