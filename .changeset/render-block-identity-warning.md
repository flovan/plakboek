---
'@plakboek/render': patch
---

Outside production, a live edit render now warns once for each block component whose markup carries no element with the block's identity, and names the block type. Such a block cannot be outlined, selected or reached by double-click in the page editor. The fix is to spread `{...edit}` on its root element. Visitor renders, plain renders and production stay silent.
