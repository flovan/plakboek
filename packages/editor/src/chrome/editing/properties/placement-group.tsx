import type { ReactElement } from 'react';
import type { ModelNode } from '../../../api-types.js';
import type { EditorStore } from '../../../client/session/store.js';
import { STRINGS } from '../../strings.js';
import { PropertyField } from './controls.js';
import { useLayoutDraft, type LayoutChangeHandler } from './layout-group.js';

export type PlacementGroupProps = {
  readonly store: EditorStore;
  readonly node: ModelNode;
  readonly onLayoutChange?: LayoutChangeHandler;
};

/** The switch is drawn by the same control as a block's own switch properties. */
const FILL_SOURCE = {
  fieldType: 'boolean',
  widget: 'switch',
  options: {},
} as const;

/**
 * The placement values a block carries beside its properties: for a block that
 * declares fill support, whether it stretches to the full height of its
 * column. The change shows in the frame at once and is saved after a pause.
 */
export function PlacementGroup(props: PlacementGroupProps): ReactElement {
  const { store, node, onLayoutChange } = props;
  const { layout, change } = useLayoutDraft(store, node, onLayoutChange);
  return (
    <section
      data-properties-group="placement"
      aria-label={STRINGS['panel.group.placement']}
    >
      <h3 className="m-0 mb-2 text-body font-semibold text-text">
        {STRINGS['panel.group.placement']}
      </h3>
      <PropertyField
        fieldKey="fill"
        label={STRINGS['panel.fill.label']}
        description={STRINGS['panel.fill.hint']}
        source={FILL_SOURCE}
        required={false}
        value={layout?.fill === true}
        needsInput={false}
        error={null}
        onChange={(value) => {
          change({ fill: value === true }, STRINGS['panel.fill.label']);
        }}
        onBlur={() => undefined}
      />
    </section>
  );
}
