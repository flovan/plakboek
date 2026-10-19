/**
 * What a field element looked like before the editor took it over, so leaving
 * it with no change gives the site back its exact markup. ProseMirror writes
 * attributes onto the element it mounts on (class, contenteditable, role,
 * tabindex, translate, aria and spellcheck attributes) and, on destroy, leaves
 * an emptied element with the editor's class, so a restore puts back every
 * attribute the element had and removes every one it did not.
 *
 * Frame nodes belong to the frame's realm: nothing here uses `instanceof`.
 */

export type FieldSnapshot = {
  readonly html: string;
  readonly attributes: ReadonlyMap<string, string>;
};

/** The element's children and attributes as they are now. */
export function snapshotField(element: Element): FieldSnapshot {
  const attributes = new Map<string, string>();
  for (const attribute of Array.from(element.attributes)) {
    attributes.set(attribute.name, attribute.value);
  }
  return { html: element.innerHTML, attributes };
}

/**
 * Puts the attributes back exactly and replaces the children with `html` (the
 * editor's last rendered children, when the content changed) or the
 * snapshot's own markup.
 */
export function restoreField(
  element: Element,
  snapshot: FieldSnapshot,
  html?: string,
): void {
  for (const attribute of Array.from(element.attributes)) {
    if (!snapshot.attributes.has(attribute.name)) {
      element.removeAttribute(attribute.name);
    }
  }
  for (const [name, value] of snapshot.attributes) {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  }
  element.innerHTML = html ?? snapshot.html;
}

/** Attributes ProseMirror puts on the nodes it renders. */
const EDITOR_ATTRIBUTES = ['contenteditable', 'draggable'] as const;

/**
 * The element's children as markup with the editor's own residue taken out:
 * placeholder separators and widgets, `contenteditable` and `draggable`
 * attributes, and the editor's class names. Used as the interim content of a
 * field that was changed, until the server's render replaces the block.
 */
export function cleanChildren(element: Element): string {
  const template = element.ownerDocument.createElement('template');
  template.innerHTML = element.innerHTML;
  const { content } = template;
  for (const residue of Array.from(
    content.querySelectorAll('.ProseMirror-separator, .ProseMirror-widget'),
  )) {
    residue.remove();
  }
  for (const node of Array.from(content.querySelectorAll('*'))) {
    for (const name of EDITOR_ATTRIBUTES) node.removeAttribute(name);
    const kept = Array.from(node.classList).filter(
      (name) => !name.startsWith('ProseMirror') && name !== 'tiptap',
    );
    if (kept.length === 0) node.removeAttribute('class');
    else node.setAttribute('class', kept.join(' '));
  }
  return template.innerHTML;
}
