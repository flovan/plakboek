---
'@plakboek/editor': minor
---

New package: the on-page editing chrome. This first release ships the package shell with a `./server` and a `./client` entry and the chrome's own precompiled stylesheet, built with Tailwind v4 for shadow roots, sized in px only and free of `@property` rules. `chromeStyleSheet(doc)` and `adoptChromeStyles(shadowRoot)` deliver it on the client, `chromeStyleElement()` and `CHROME_STYLE_CSP_HASH` deliver it as first-paint markup for hosts with a strict `style-src`.
