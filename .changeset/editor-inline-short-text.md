---
'@plakboek/editor': minor
---

Short text properties marked with `edit.field()` (headings, labels, titles) are typed in place on the page as one plain line. The property's `maxLength` is enforced the way the server counts it, Enter ends the field like Done, and a multi-line paste becomes one line cut to the room left. While a short text field is active a compact bar replaces the block toolbar, with the block's breadcrumb, a character counter that reads "Limit reached" at the limit, and Done; it sits above the field, flips below when there is no room and stays inside a field taller than the frame. The Properties panel input follows the typing within 150ms, and focusing it first ends the page session so the panel then edits as before.
