---
'@plakboek/editor': minor
---

Add the fragment patcher every frame update goes through and the development block swap. Server fragments are applied to the framed site by replacing a block by id, creating, removing or reordering top-level sections, or reloading the frame when an anchor is missing; markup is parsed in the frame's own document so scripts stay inert, the scroll position is restored after each patch, and a block that is being edited in place is never replaced or removed until the edit ends. The new development-only `@plakboek/editor/hot` entry finds the blocks whose own markup changed between two renders and swaps them through the same patch, and announces them with a `plakboek:blocks-swapped` event.
