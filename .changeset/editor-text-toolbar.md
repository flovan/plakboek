---
'@plakboek/editor': minor
---

While the caret is in a rich text field, a floating text toolbar replaces the block toolbar. It sits above the field (below when there is no room, pinned inside a field taller than the frame) and stays put as the selection moves. It has a Text style menu (Paragraph, Title, Heading and Subheading, producing h2, h3 and h4, never h1), Bold, Italic, Underline and Strikethrough, Bulleted and Numbered lists, and Done. Every control mirrors the property's effective text theme: one the theme does not allow has no button, and the Text style menu is absent when only paragraphs are allowed. Pressing a button keeps the field's focus and selection; Alt+F10 moves focus to the toolbar, the arrows rove, Escape returns to the field, toggles carry `aria-pressed` and `aria-keyshortcuts`, and each change is announced ("Bold on.", "Heading.") whether it came from a button or a shortcut.
