---
'@plakboek/core': minor
---

Serve the editor's JSON API from every host under `/cms/api/*`, a resource route placed before the `/cms/*` pages route. Every answer carries `X-Robots-Tag: noindex, nofollow`, errors included, and the editor's server code loads only when the first API request arrives. A host process now also upgrades stored page trees that predate columns to the column shape in the background after it starts, without delaying any request.
