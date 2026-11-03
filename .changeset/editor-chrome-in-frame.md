---
'@plakboek/editor': minor
---

The page-anchored editor chrome (outlines, chips, the block toolbar, insert points, the block picker, empty-page prompts and needs-input markers) now lives in the framed document and scrolls with the page, so it stays on its element during fast scrolling and follows the elastic bounce at the page ends. The drag line is drawn in document coordinates and stays on its slot while the frame auto-scrolls. Keyboard reach is unchanged: Tab from the page region moves to the block toolbar in the frame, Shift+Tab returns to the region, and Tab from the toolbar continues to the next control of the editor.
