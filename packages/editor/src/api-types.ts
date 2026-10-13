/**
 * The editor API contract, shared by the editor server (which writes these
 * shapes) and the editor client (which reads them). Types and one constant
 * only: no imports and no runtime logic, so the client can import it without
 * pulling anything server-side into its module graph.
 */

/** Where every editor API route lives. */
export const EDITOR_API_BASE = '/cms/api';

/** What an item is in the page tree: a section, a column inside one, or any other block. */
export type ModelKind = 'section' | 'column' | 'block';

/** How a section aligns its columns on the cross axis. */
export type ColumnAlign = 'stretch' | 'start' | 'center' | 'end';

/** The layout values an item carries beside its own properties. */
export type ModelLayout = {
  /** A column ratio such as `1:2`, on a section. */
  readonly columns?: string;
  readonly align?: ColumnAlign;
  /** A block that stretches to fill its column. */
  readonly fill?: boolean;
};

/** One item of the page tree as the editor sees it. */
export type ModelNode = {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly kind: ModelKind;
  readonly sortOrder: number;
  readonly depth: number;
  readonly version: number;
  readonly props: Readonly<Record<string, unknown>>;
  readonly layout: ModelLayout | null;
  /** Keys of required properties that still have no value. */
  readonly needsInput: readonly string[];
  readonly unavailable: 'unknown' | 'degraded' | null;
};

/** Content a block inserts under itself when an editor adds it. */
export type StarterNode = {
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly children?: readonly StarterNode[];
};

/** One editable property of a block type, with its installation constraint resolved. */
export type CatalogueProperty = {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly fieldType: string;
  readonly widget: string;
  readonly required: boolean;
  readonly defaultValue?: unknown;
  readonly options: unknown;
  readonly constraint: 'none' | 'fixed' | 'narrowed';
  readonly fixedValue?: unknown;
  readonly allowedValues?: readonly string[];
};

/** One block type the editor may offer, with the placement rules the engine enforces. */
export type CatalogueEntry = {
  readonly key: string;
  readonly kind: ModelKind;
  readonly editor: {
    readonly label: string;
    readonly description?: string;
    readonly icon?: string;
    readonly category?: string;
  };
  readonly placement: {
    readonly ownerTypes: readonly string[];
    readonly allowedParents: readonly string[] | 'any';
    readonly allowedChildren: readonly string[] | 'any' | 'none';
  };
  readonly supportsFill: boolean;
  readonly starterChildren: readonly StarterNode[];
  readonly properties: readonly CatalogueProperty[];
};

/** Who holds the page's edit lock, as the current editor may see it. */
export type LockView = {
  readonly enabled: boolean;
  readonly state: 'free' | 'mine' | 'other';
  readonly holder: {
    readonly name: string;
    readonly lastActiveAt: string;
  } | null;
  readonly canTakeOver: boolean;
  readonly expiresAt: string | null;
};

/** The configured limits the editor and the engine both apply. */
export type SessionLimits = {
  readonly sectionNestingDepth: number;
  readonly blockDepthCeiling: number;
  readonly maxOps: number;
  readonly maxNodes: number;
  readonly heartbeatSeconds: number;
  readonly lockTtlSeconds: number;
};

/** Everything the editor needs to start working on a page. */
export type EditorSession = {
  readonly pageId: string;
  readonly locale: string;
  readonly pageVersion: number;
  readonly canDelete: boolean;
  readonly columnsEnabled: boolean;
  readonly lock: LockView;
  readonly catalogue: readonly CatalogueEntry[];
  readonly columnPresets: readonly string[];
  readonly limits: SessionLimits;
  readonly tree: readonly ModelNode[];
  readonly upgraded: boolean;
};

/**
 * Where an item goes: under `parentId` (null for the page), immediately after
 * `previousId` and immediately before `nextId` when those are given.
 */
export type EditPosition = {
  readonly parentId: string | null;
  readonly previousId?: string | null;
  readonly nextId?: string | null;
};

/** A new item (and its descendants) an insert op creates. */
export type EditNode = {
  readonly id?: string;
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly layout?: ModelLayout | null;
  readonly children?: readonly EditNode[];
};

/** One structural or property change. */
export type EditOp =
  | {
      readonly op: 'insert';
      readonly position: EditPosition;
      readonly node: EditNode;
    }
  | {
      readonly op: 'update';
      readonly blockId: string;
      readonly baseVersion: number;
      readonly props?: Readonly<Record<string, unknown>>;
      readonly layout?: ModelLayout | null;
    }
  | {
      readonly op: 'move';
      readonly blockId: string;
      readonly baseVersion: number;
      readonly position: EditPosition;
    }
  | {
      readonly op: 'delete';
      readonly blockId: string;
      readonly baseVersion: number;
    }
  | {
      readonly op: 'duplicate';
      readonly blockId: string;
      readonly newId?: string;
    };

/** A batch of ops applied together against one page version. */
export type EditRequest = {
  readonly basePageVersion: number;
  readonly ops: readonly EditOp[];
  /** Ask for rendered fragments of what changed. */
  readonly fragments?: boolean;
};

/** One item's rendered markup. */
export type Fragment = { readonly id: string; readonly html: string };

/** What to change in the frame after a write. */
export type FragmentPatch = {
  readonly fragments: readonly Fragment[];
  readonly removed: readonly string[];
  /** The new order of the page's top-level sections, when it changed. */
  readonly rootOrder: readonly string[] | null;
};

export type EditResponse = {
  readonly ok: true;
  readonly pageVersion: number;
  readonly tree: readonly ModelNode[];
  readonly createdIds: readonly string[];
  readonly deletedIds: readonly string[];
  readonly patch: FragmentPatch | null;
};

/** Render an item with unsaved values, to preview a change without writing it. */
export type PreviewRequest = {
  readonly blockId: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly layout?: ModelLayout | null;
};

/** One problem with one property or layout value. */
export type ApiIssue = { readonly key: string; readonly code: string };

export type PreviewResponse =
  | {
      readonly ok: true;
      readonly html: string;
      readonly needsInput: readonly string[];
    }
  | { readonly ok: false; readonly issues: readonly ApiIssue[] };

export type ApiErrorCode =
  | 'invalid-request'
  | 'unauthenticated'
  | 'forbidden'
  | 'not-found'
  | 'stale-page'
  | 'stale-block'
  | 'conflict'
  | 'locked'
  | 'lock-changed'
  | 'locking-disabled'
  | 'placement'
  | 'unknown-type'
  | 'invalid-props'
  | 'invalid-layout'
  | 'section-column-required'
  | 'too-large'
  | 'server-error';

export type ApiError = {
  readonly ok: false;
  readonly error: {
    readonly code: ApiErrorCode;
    readonly issues?: readonly ApiIssue[];
    readonly lock?: LockView;
  };
};

/** Open the page at this address for editing. */
export type OpenRequest = { readonly path: string };

export type TreeResponse = {
  readonly ok: true;
  readonly pageVersion: number;
  readonly tree: readonly ModelNode[];
};

export type LockResponse = { readonly ok: true; readonly lock: LockView };
