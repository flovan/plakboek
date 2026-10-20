---
'@plakboek/editor': minor
---

An editor can link text in place. The text toolbar's Link button (or Ctrl/Cmd+K, or a click on a link in the field) opens a popover that links the selected words, edits the link at the caret, or inserts the target's title when nothing is selected. A link points to a page of the site, found by title or path and stored by id so it keeps working when the page's address changes, or to a web address, `mailto:` or `tel:` address, with an optional new tab. Addresses the shared href policy refuses, such as `javascript:`, cannot be linked, typed or pasted. The page search route also answers a lookup of one page by id, so the popover can tell when a link's page no longer exists.
