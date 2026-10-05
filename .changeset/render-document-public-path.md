---
'@plakboek/render': minor
---

A host document composer now receives `publicPath`, the canonical visitor path the page is served at (`/` for the home page, `/about`, `/nl` for a locale root), so a header or footer template can mark the current link. A composer may also return a `Promise<string>`: the handler awaits it inside the render guard, so a rejecting composer becomes the host 500 page with `Cache-Control: no-store`, is reported once through `onRenderError`, and is never cached. Synchronous composers, including `renderDefaultDocument`, keep working unchanged.
