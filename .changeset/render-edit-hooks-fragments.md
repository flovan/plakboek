---
'@plakboek/render': minor
---

Add `defineBlockEdit` to the root entry: an identity helper with no runtime weight for declaring a block's editor lifecycle hooks (`enter`, `leave`, `select`, `deselect`, `reveal`, `rendered`), so an interactive block can react to selection and mode without its hook code reaching visitors. Add `renderBlockFragments` to the server entry: it renders any block of a live tree, subtree included, to exactly the markup the frame document shows for it. The package's types now name DOM globals (`Element`, `Document`, `Window`) for the hook context.
