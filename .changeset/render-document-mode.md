---
'@plakboek/render': minor
---

Document composers now learn which rendering they produce: `DocumentInput` gains a required `mode: 'visitor' | 'edit'` (the new `DocumentMode` type), and the visitor handler always passes `'visitor'`. A host's document omits analytics and third-party widgets when `mode` is `'edit'` and keeps block-owned scripts. Anyone who constructs a `DocumentInput` by hand, a test or a custom composer wrapper for example, must now set `mode`.

The Edit pill on visitor pages no longer jumps to `?_edit=1`: it navigates to `/cms?next=<current page>` so the server decides whether a session continues straight into editing or sees the login screen, and it never renders inside a frame. The two new constants `CMS_LOGIN_PATH` (`/cms`) and `NEXT_PARAM` (`next`) are exported from the root entry. The inline bootstrap text changed, so `TOOLBAR_BOOTSTRAP_CSP_HASH` changed: hosts that pin the hash in `script-src` should use the exported constant.
