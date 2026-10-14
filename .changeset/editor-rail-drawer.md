---
'@plakboek/editor': minor
---

Editing tools in the full-width layout. The rail now carries the mode button, Undo, Redo, the save status (a retry button when saving failed) and Blocks and Properties buttons, each with a tooltip. Blocks and Properties open a 280px drawer beside the rail that pushes the site narrower instead of covering it, keeping the selection and the scroll position, and closing it restores the width. The drawer starts with the page's notice, a dot on the rail marks a notice nobody has read, and focus moves into the drawer on open and back to its button on Escape. If the pushed site would be narrower than 320px, the sidebar layout is shown instead.
