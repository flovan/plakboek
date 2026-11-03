---
'@plakboek/editor': minor
---

Editor chrome gets one closed-shadow host inside the framed document while a page is edited in Edit mode, so overlays can scroll with the page natively. The site document is otherwise untouched: the host sits outside `<body>`, takes no pointer events, adds no style attribute, stylesheet or scrollable overflow, and is removed in Interact mode and when editing ends. Clicks on chrome inside the frame are no longer cancelled by the Edit-mode claim.
