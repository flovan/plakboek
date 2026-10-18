---
'@plakboek/pages': patch
---

`upgradeSectionColumns` and `upgradeAllSectionColumns` now respect the page edit lock: a page held by someone else's live lock is left untouched, so its version does not move under an open editor, and the batch upgrade skips such pages until the lock is gone. `upgradeSectionColumns` takes an optional `actorUserId` whose own lock does not block it. The editor's page open takes the lock first and upgrades only a page it holds or that nobody holds.
