---
'@plakboek/pages': minor
'@plakboek/editor': minor
---

Links can now point at pages. `@plakboek/pages` adds `searchPages`, which finds the non-trashed pages of one locale by title or path (literal match, at most 20, ordered by title), and `resolvePageLinkPaths`, which turns stored page ids into public paths in at most two statements, optionally leaving out pages that are not live. `@plakboek/editor` adds `GET /cms/api/pages/search?locale=&q=` behind the same gate as every editor route, and an `ApiClient.searchPages` method for the page picker.
