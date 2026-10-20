---
'@plakboek/editor': minor
---

Rich text fields are edited in the host's own markup: the editor's node views are derived from the theme's renderers, so the field does not move when editing starts and the caret lands where you clicked. Pasted content is cleaned before the editor reads it and you are told when formatting was removed to match the theme. Stored text that holds formatting the theme no longer allows is never opened for editing; a notice offers to keep it as it is or to remove the unsupported formatting while keeping every word. Empty fields show a hint while selected, and the active field gets a dashed boundary when it is smaller than its block.
