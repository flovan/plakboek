---
'@plakboek/pages': minor
---

New `resolveEditablePage` reads a page's live working tree by public path, for the editor: unpublished changes are included, draft-only and scheduled pages resolve, trashed pages do not, and it shares the visitor resolver's redirect, not-found and invalid-pattern outcomes without reading a publication. The first address segments `cms` and `api` are now reserved: creating, renaming, moving or translating a page so its path starts with one throws `ReservedPageSlugError`, and a generated root slug skips them (`cms-2`). `checkReservedPagePaths` and `reportReservedPagePaths` (hook `onReservedPagePath`) flag pages that already sit on a reserved segment at boot; they are kept, never deleted or renamed. `RESERVED_PAGE_PATH_SEGMENTS` exposes the list.
