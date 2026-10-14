---
'@plakboek/editor': minor
---

Delete and duplicate from the page. The floating toolbar gains Duplicate and Delete buttons, and Delete, Backspace and Control or Command with D do the same from the keyboard. Deleting an item that holds no blocks is instant and leaves an undo toast; deleting one that holds blocks first asks in a modal dialog and says how many go with it. Undo, from the toast or the history, brings the item back with its whole subtree under the original ids and selects it. After a delete the next sibling is selected, else the previous, else the parent. A section's only column cannot be deleted, and for a role without the delete permission Delete and the undo of an insert or copy are off with the reason shown.
