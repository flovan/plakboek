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
