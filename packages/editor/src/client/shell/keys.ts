/**
 * The keyboard shortcuts of the edit shell, as a pure decision over a key
 * event: which action a key means, given where it was pressed.
 *
 * A shortcut never fires while the user types: the target must not be a text
 * input, a select, a textarea or content-editable. Events come from two
 * documents (the shell and the framed site), so the target is recognised by its
 * shape and never with `instanceof`.
 */

export type KeyAction = 'toggle-mode' | 'climb';

const TEXT_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

/** Whether typing into this target would change text or a choice. */
export function isEditableTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const tag: unknown = Reflect.get(target, 'tagName');
  if (typeof tag === 'string' && TEXT_TAGS.has(tag.toUpperCase())) return true;
  return Reflect.get(target, 'isContentEditable') === true;
}

export type KeyInput = {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
};

/** `I` toggles the mode and Escape climbs one level; anything else is not ours. */
export function keyAction(input: KeyInput, target: unknown): KeyAction | null {
  if (input.ctrlKey || input.metaKey || input.altKey) return null;
  if (isEditableTarget(target)) return null;
  if (input.key === 'i' || input.key === 'I') return 'toggle-mode';
  if (input.key === 'Escape') return 'climb';
  return null;
}

/** What a structure key means for the selection, decided apart from the DOM. */
export type StructureAction =
  | { readonly kind: 'sibling'; readonly direction: 'next' | 'previous' }
  | { readonly kind: 'edge'; readonly edge: 'first' | 'last' }
  | { readonly kind: 'drill' }
  | { readonly kind: 'climb' }
  | { readonly kind: 'move'; readonly direction: 'earlier' | 'later' }
  | { readonly kind: 'undo' }
  | { readonly kind: 'redo' };

/** Where focus was when the key was pressed. */
export type StructureFocus = {
  /** On the page region itself. */
  readonly inRegion: boolean;
  /** On a control of the floating toolbar. */
  readonly inToolbar: boolean;
  /** How the selected item's siblings sit; decides which Alt+Arrow moves. */
  readonly axis: 'horizontal' | 'vertical';
};

export type StructureKeyInput = KeyInput & { readonly shiftKey: boolean };

/**
 * The keyboard model of the page region (UI-SPEC S2): arrows walk the siblings
 * of the scope, Right or Enter drill in, Left climbs, Home and End jump, Alt
 * and an arrow along the siblings' axis move the selection, and Control or
 * Command with Z undoes (with Shift, redoes). Plain keys act only with focus
 * on the region, or for Up and Down on the toolbar, which keeps the left and
 * right arrows and Home and End for itself. Nothing fires while the user
 * types.
 */
export function structureKeyAction(
  input: StructureKeyInput,
  target: unknown,
  focus: StructureFocus,
): StructureAction | null {
  if (isEditableTarget(target)) return null;
  const { key } = input;
  const command = input.ctrlKey || input.metaKey;

  if (command && !input.altKey && (key === 'z' || key === 'Z')) {
    return { kind: input.shiftKey ? 'redo' : 'undo' };
  }
  if (!focus.inRegion && !focus.inToolbar) return null;

  if (input.altKey && !command && !input.shiftKey) {
    const along =
      focus.axis === 'horizontal'
        ? { earlier: 'ArrowLeft', later: 'ArrowRight' }
        : { earlier: 'ArrowUp', later: 'ArrowDown' };
    if (key === along.earlier) return { kind: 'move', direction: 'earlier' };
    if (key === along.later) return { kind: 'move', direction: 'later' };
    return null;
  }
  if (command || input.altKey || input.shiftKey) return null;

  if (key === 'ArrowDown') return { kind: 'sibling', direction: 'next' };
  if (key === 'ArrowUp') return { kind: 'sibling', direction: 'previous' };
  if (!focus.inRegion) return null;
  if (key === 'Home') return { kind: 'edge', edge: 'first' };
  if (key === 'End') return { kind: 'edge', edge: 'last' };
  if (key === 'ArrowRight' || key === 'Enter') return { kind: 'drill' };
  if (key === 'ArrowLeft') return { kind: 'climb' };
  return null;
}
