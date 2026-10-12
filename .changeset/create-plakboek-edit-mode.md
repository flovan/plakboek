---
'create-plakboek': minor
---

The starter now follows the edit-mode conventions. The root element of `app/site/document.tsx` is a container query root (`@container`), and the starter uses no viewport breakpoint variants. `renderPage` takes the document `mode`, and a new `thirdPartyScripts(mode)` returns nothing in edit mode, so analytics and third-party widgets stay out while an editor works on the page; the error pages render as visitor pages. The README gains an "Edit mode" section (sign-in at `/cms`, the framed site, the `mode` rule, spreading `edit` in blocks, no `X-Frame-Options: DENY` or `frame-ancestors 'none'`, container queries) and describes the reserved `cms` and `api` first segments. The fresh-install proof now checks that the editor is built but never reaches an anonymous visitor.
