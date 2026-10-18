---
'@plakboek/core': minor
'@plakboek/render': minor
'@plakboek/editor': minor
---

Editing a block component under `pnpm dev` now swaps just that block instead of reloading the page. The `plakboek()` Vite plugin tells a block change (a module the config reaches that the site document does not) from every other server change and sends the custom `plakboek:blocks-changed` event for it; changes to the config, the site document, route modules and anything outside the config's imports still reload the page. A small dev client, loaded on visitor pages and in the edit frame, fetches the page again and replaces the blocks whose markup changed, then runs their `rendered` hook; in the edit frame the editor's hooks runtime runs it, so the edit shell, the selection and the frame's scroll position stay. Visitor pages carry block markers and the dev client only under the dev server, never in a production response.
