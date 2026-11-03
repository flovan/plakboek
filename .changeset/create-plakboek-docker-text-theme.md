---
'create-plakboek': patch
---

The starter's production image now includes `text-theme.tsx`. `plakboek.config.ts` imports it, so `plakboek bootstrap` and the server failed in the container with "Cannot find module '/app/text-theme.tsx'".
