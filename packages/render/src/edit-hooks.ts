/**
 * Block lifecycle hooks for interactive blocks (D-14): a carousel, accordion
 * or tabs block reacts to the editor's selection and mode without that code
 * ever reaching a visitor.
 *
 * `defineBlockEdit` is an identity function with no runtime weight and no
 * import, so it is safe in any bundle and a host needs no editor dependency.
 * Delivery: a host puts `export default defineBlockEdit({ ... })` in a
 * `*.edit.ts` or `*.edit.tsx` file next to its block. The CMS's Vite plugin
 * loads those files only into the editor's own chunk, and the build fails if
 * a visitor-facing chunk reaches one.
 *
 * When the editor calls a hook (every call is contained: a throw is logged by
 * name and never blocks selection):
 *
 * - `enter`: on every block with hooks when Edit mode starts (frame load in
 *   Edit, switching from Interact, and after `rendered` while in Edit).
 * - `leave`: on switching to Interact.
 * - `select` / `deselect`: when the selection moves onto or off the block.
 * - `reveal`: on the selected block and on each ancestor with hooks, outermost
 *   first, so a container can bring a nested block into view; `targetId` is
 *   the selected block.
 * - `rendered`: after the editor or the dev swap replaced the block's element,
 *   so the block can re-run its own initialisation on the new element.
 */

/** Which of the editor's two modes is active. */
export type BlockEditMode = 'edit' | 'interact';

/** What every hook receives. */
export type BlockEditContext<P = Readonly<Record<string, unknown>>> = {
  readonly id: string;
  readonly blockType: string;
  /** The block's current root element in the frame document. */
  readonly element: Element;
  /** The frame document and window the block lives in. */
  readonly document: Document;
  readonly window: Window;
  readonly props: Readonly<P>;
  readonly mode: BlockEditMode;
};

/** What `reveal` receives: the context plus the block being revealed. */
export type BlockRevealContext<P = Readonly<Record<string, unknown>>> =
  BlockEditContext<P> & {
    readonly targetId: string;
  };

export type BlockEditHooks<P = Readonly<Record<string, unknown>>> = {
  readonly enter?: (context: BlockEditContext<P>) => void;
  readonly leave?: (context: BlockEditContext<P>) => void;
  readonly select?: (context: BlockEditContext<P>) => void;
  readonly deselect?: (context: BlockEditContext<P>) => void;
  readonly reveal?: (context: BlockRevealContext<P>) => void;
  readonly rendered?: (context: BlockEditContext<P>) => void;
};

export type BlockEditModule<P = Readonly<Record<string, unknown>>> = {
  readonly blockType: string;
  readonly hooks: BlockEditHooks<P>;
};

/** Declares a block type's editor lifecycle hooks; returns its argument. */
export function defineBlockEdit<P = Readonly<Record<string, unknown>>>(
  module: BlockEditModule<P>,
): BlockEditModule<P> {
  return module;
}
