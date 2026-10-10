---
'@plakboek/editor': minor
---

The edit shell now outlines the block under the pointer in the framed site. A 2px outline with a 1px halo is drawn exactly over the block's box, with a label chip carrying the block's editor label (or its type key; `{type} (unavailable)` for a block the host no longer declares), and a 1px dashed outline for the section around it. Everything is drawn in a layer of the shell, clipped to the frame, and nothing is added to the site's own document. The outline follows its block through scrolling, window resizes, the layout toggle and changes to the page, is updated at most once per animation frame, and clicks, keys and scrolling pass through to the site untouched. A read-only session gets no overlay.
