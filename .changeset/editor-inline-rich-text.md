---
'@plakboek/editor': minor
---

A `rich_text` property that a block marks with `edit.field('prop')` is now edited in place on the page. One click on the text selects the block and puts the caret under the pointer; typing edits the site's own markup, with the property's effective text theme as its only schema (no level 1 heading, and nothing the theme leaves out can be typed or pasted). The text saves after a short pause or when the field is left, as one undo step per typing burst, and an emptied field saves as no value. A field is left with Escape (the block stays selected), a click elsewhere, a different selection, the sidebar or rail Undo and Redo, a structural action, a frame reload or lost editing access, and it gives the site its exact markup back when nothing changed. A field on a button, an input, or a property fixed by the installation is not edited in place.
