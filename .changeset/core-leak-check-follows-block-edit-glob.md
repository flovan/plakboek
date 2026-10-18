---
'@plakboek/core': patch
---

The client build's check that keeps editor code away from visitors now takes the block hook modules from what the `blockEdit` glob matched, instead of treating every host file named `*.edit.ts` or `*.edit.tsx` as editor code. A host route such as `profile.edit.tsx` no longer fails the build, and a hook module picked up by a custom `blockEdit` glob under any name is still caught when a visitor chunk imports it.
