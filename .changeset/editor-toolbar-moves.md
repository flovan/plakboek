---
'@plakboek/editor': minor
---

Rearrange the page from the page. A selected item gets a floating toolbar with a breadcrumb that selects any ancestor and Move earlier and Move later buttons that cross column and section boundaries (left and right when the siblings sit side by side, with the reason shown when an item is already at the start or end). The page region is a tab stop in Edit mode with a keyboard model: arrows walk the siblings, Right or Enter drill in, Left or Escape climb, and Alt with an arrow moves the selection. Every structural action is saved at once as one request, the framed site is patched in place with its scroll position kept, and the moved item stays selected and flashes. Undo and redo buttons (and Control or Command with Z) apply the inverse or forward write for the rest of the session. A save that fails leaves the page as it was and offers Retry; a write whose answer was lost is checked against the stored page before it is sent again.
