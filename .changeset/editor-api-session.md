---
'@plakboek/editor': minor
---

Add the editor's JSON API on the server: `createEditorApi` answers `/cms/api` for core to mount. `POST /cms/api/open` takes a page's visitor path and returns everything the editor starts with (the page id and version, the block catalogue built on the server so hidden properties never leave it, the column-shaped tree, the lock, the column presets and the limits) and takes the page's edit lock when it is free. Lock endpoints (state, acquire, renew, release, take over, the last allowed only by the engine's permission-superset rule) and a tree read live under `/cms/api/pages/:id/`. Every request needs a session and a role that can edit pages; every `POST` must be JSON from this site, its body is capped at 1 MiB and validated, and every answer is `no-store` JSON whose errors carry a code and, for a refused value, keys and codes only. The frame now marks column cells as columns.
