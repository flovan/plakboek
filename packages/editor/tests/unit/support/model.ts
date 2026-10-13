import type {
  CatalogueEntry,
  ModelKind,
  ModelNode,
} from '../../../src/api-types.js';

/** A nested description of a page tree, flattened into model nodes by `buildNodes`. */
export type Spec = {
  readonly id: string;
  readonly type: string;
  readonly kind: ModelKind;
  readonly children?: readonly Spec[];
};

export const section = (
  id: string,
  children: readonly Spec[] = [],
  type = 'section',
): Spec => ({
  id,
  type,
  kind: 'section',
  children,
});
export const column = (id: string, children: readonly Spec[] = []): Spec => ({
  id,
  type: 'column',
  kind: 'column',
  children,
});
export const block = (
  id: string,
  type: string,
  children: readonly Spec[] = [],
): Spec => ({
  id,
  type,
  kind: 'block',
  children,
});

/** Flattens specs into model nodes with depth, parent and sibling order filled in. */
export function buildNodes(roots: readonly Spec[]): ModelNode[] {
  const nodes: ModelNode[] = [];
  const visit = (
    specs: readonly Spec[],
    parentId: string | null,
    depth: number,
  ): void => {
    specs.forEach((spec, index) => {
      nodes.push({
        id: spec.id,
        parentId,
        type: spec.type,
        kind: spec.kind,
        sortOrder: (index + 1) * 1000,
        depth,
        version: 1,
        props: {},
        layout: null,
        needsInput: [],
        unavailable: null,
      });
      visit(spec.children ?? [], spec.id, depth + 1);
    });
  };
  visit(roots, null, 0);
  return nodes;
}

/** A catalogue entry with the placement defaults a plain declaration gets. */
export function catalogueEntry(
  key: string,
  kind: ModelKind,
  placement: Partial<CatalogueEntry['placement']> = {},
): CatalogueEntry {
  return {
    key,
    kind,
    editor: { label: key },
    placement: {
      ownerTypes: ['page'],
      allowedParents: 'any',
      allowedChildren: kind === 'block' ? 'none' : 'any',
      ...placement,
    },
    supportsFill: false,
    starterChildren: [],
    properties: [],
  };
}
