---
'@plakboek/pages': minor
---

A publication now freezes the page's `title` and head SEO set inside its snapshot, and the visitor resolver reads them from there instead of the live `pages` row. Retitling a page no longer changes the served `<title>` until it is republished. A snapshot published before this change has neither, and serves an empty title and the default SEO set until the page is republished.
