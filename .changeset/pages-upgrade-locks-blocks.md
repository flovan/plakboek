---
'@plakboek/pages': patch
---

`upgradeSectionColumns` now locks the page's block rows while it reads them, so a property edit committing during the upgrade can no longer leave the recorded revisions describing props the stored rows no longer have.
