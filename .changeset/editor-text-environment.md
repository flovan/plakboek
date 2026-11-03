---
'@plakboek/editor': minor
'@plakboek/core': patch
---

The edit frame, the live preview and saved fragments render rich text through the host's text theme, with page links resolved whether or not the target page is published, so the markup the editor mounts on is the visitor's markup. The edit entrypoint and the editor API take the installation's `textTheme`, and the block catalogue carries each rich text property's effective theme (the installation's theme narrowed by the property) so the client builds its schema from exactly what the server accepts. `@plakboek/content` is now a runtime dependency of the editor.
