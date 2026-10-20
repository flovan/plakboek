import type { CSSProperties, ReactElement } from 'react';
import type { FieldBox } from '../../../client/overlay/field-boxes.js';
import type { Box } from '../../../client/overlay/geometry.js';
import { STRINGS } from '../../strings.js';

/** The empty-field chip's inset from the field's top left corner. */
const CHIP_INSET = 4;

export type FieldDecorProps = {
  /** The rich text fields of the selected block, measured in the frame. */
  readonly fields: readonly FieldBox[];
  /** The key of the field being edited, or null. */
  readonly activeKey: string | null;
};

function boxStyle(box: Box): CSSProperties {
  return {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
  };
}

/** A field counts as smaller than its block when it leaves room on any side. */
function isSmaller(field: FieldBox): boolean {
  return (
    field.box.width < field.block.width - 1 ||
    field.box.height < field.block.height - 1
  );
}

/**
 * What the editor draws around a rich text field, in the overlay plane inside
 * the frame: a hint chip in an empty field while its block is selected or the
 * field is active, and a dashed boundary with a halo around the active field
 * when it is smaller than its block. Both are decoration only (not in the
 * accessibility tree, no pointer events, never saved) and nothing is added to
 * the site's own elements.
 */
export function FieldDecor(props: FieldDecorProps): ReactElement | null {
  const { fields, activeKey } = props;
  if (fields.length === 0) return null;
  return (
    <>
      {fields.map((field) => (
        <div key={field.key} className="pk-field-decor" aria-hidden="true">
          {activeKey === field.key && isSmaller(field) ? (
            <div
              className="pk-field-boundary"
              data-field-boundary={field.key}
              style={boxStyle(field.box)}
            />
          ) : null}
          {field.empty ? (
            <div
              className="pk-field-chip"
              data-field-chip={field.key}
              style={{
                left: field.box.left + CHIP_INSET,
                top: field.box.top + CHIP_INSET,
              }}
            >
              {STRINGS['text.field.placeholder.rich']}
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
}
