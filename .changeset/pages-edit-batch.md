---
'@plakboek/pages': minor
---

Add `applyBlockEdit`, the editor's batch write: insert (with subtrees and client-chosen ids), update, move and delete operations against one page, applied in one transaction with one revision batch, one audit row and one page version bump. Every block id a batch names is checked against the page it was sent for, a batch holding a delete needs `pages:delete`, and a batch never publishes or purges a cache. Ordering a block between siblings now reads the missing neighbour from the stored list, so "after X" lands directly after X.
