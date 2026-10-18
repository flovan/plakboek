---
'@plakboek/editor': minor
---

Select on the page in edit mode. The editor opens an editing session when the shell hydrates, claims clicks in the framed site and selects sections, columns and blocks by click, double-click, a click outside the scope and Escape, drawn as an outline in the shell and never as styles on the site. An Edit and Interact toggle (also the `I` key) hands the site back to the user and takes it again without reloading it, hover outlines only what a click would select, and mode changes and selections are announced to screen readers. While editing, the page lock is renewed on a heartbeat and again when the tab becomes visible, and released when the page is left. A user who cannot edit, or who finds the page locked by another editor, keeps the read-only shell.
