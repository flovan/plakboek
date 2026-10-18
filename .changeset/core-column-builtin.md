---
'@plakboek/core': minor
'create-plakboek': minor
---

Every installation now registers the CMS-owned `column` block after the host's blocks, and a host block with the key or kind `column` is refused when the config is evaluated. Seed sections may stay flat: bootstrap wraps their blocks in one column. `defineConfig` accepts `columnPresets` to narrow or extend the column ratios. The starter section renders `Columns` around its children, sets `--plakboek-column-gap` and stacks columns below 640px of container width.
