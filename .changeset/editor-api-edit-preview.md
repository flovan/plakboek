---
'@plakboek/editor': minor
---

Add the edit and preview routes to the editor API. `POST /cms/api/pages/:id/edit` applies a batch of up to 50 insert, update, move, delete and duplicate operations as one write and answers the new page version, the page tree and the rendered fragments the frame needs to follow the change: only the updated blocks for a property edit, the touched top level sections for a structural one. `POST /cms/api/pages/:id/preview` renders one block with candidate values using the checks a write applies, without writing, locking or bumping the version, and reports invalid values by key and code only.
