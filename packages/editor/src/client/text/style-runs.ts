/**
 * Where a rich text field carries custom style (a colour or size mark, or an
 * alignment), worked out for the edit-mode marker.
 */
export type JsonNode = {
  readonly type?: string;
  readonly text?: string;
  readonly marks?: readonly { readonly type?: string }[];
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly JsonNode[];
};

export type StyleRunKind = 'style' | 'align';

/** A run of the field's flattened text, `[start, end)`. */
export type StyleRun = {
  readonly kind: StyleRunKind;
  readonly start: number;
  readonly end: number;
};

export function flattenedText(_doc: JsonNode): string {
  return '';
}

export function customStyleRuns(_doc: JsonNode): readonly StyleRun[] {
  return [];
}
