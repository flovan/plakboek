---
'@plakboek/render': minor
---

Every block component now receives a frozen `layout` prop (`columns`, `align`, `fill`), separate from its declared `props`. The root entry gains `Columns`, the CSS grid a host section renders around its children (ratio tracks, alignment and a `--plakboek-column-gap` gap, stackable with one container-query rule), `ColumnBlock`, the core column cell, `columnTracks`, `isLiveEdit`, and the `BlockLayout`, `ColumnAlign` and `ColumnsProps` types. The edit attribute contract names `data-pk-empty` and `data-pk-inline-editing`, and the live proxy and block metadata accept the `column` kind. `BlockComponentProps` has a new required `layout` field, so code that constructs it by hand must pass one.
