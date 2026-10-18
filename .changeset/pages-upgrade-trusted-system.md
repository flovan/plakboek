---
'@plakboek/pages': patch
---

`upgradeSectionColumns` and `upgradeAllSectionColumns` are documented as trusted system operations: they take no actor, check no permission and write no audit row (the revision batch they record has no author), so a caller must authorise the call itself and no HTTP route may expose them directly.
