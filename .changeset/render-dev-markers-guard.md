---
'@plakboek/render': patch
---

The visitor handler no longer relies on the host alone to keep the development block markers out of production. They are left out when `NODE_ENV` is `production` (as well as when a cache is configured), and a page rendered with them is always answered `Cache-Control: no-store`, so a `devBlockMarkers` flag set by mistake cannot expose block ids or the block catalogue, or let a proxy store such a page.
