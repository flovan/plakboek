---
'@plakboek/editor': minor
---

Adds `createCmsPages`, the handler behind the admin entry under `/cms`. `/cms` shows the real page, blurred, inert and hidden from assistive technology in a same-origin iframe, with the sign-in card in a native dialog painted from declarative shadow DOM, so it is there at first paint without any script. `?next=` is accepted only as a path on this site. A valid session goes straight to the page in edit mode; a role that still has to set up two-step sign-in is sent to `/cms/two-factor/enrol`. The set-password, reset-password and sign-in-link landings, an invalid-link step shared by expired, used and malformed links, and the confirm step of two-step set-up are served at `/cms/set-password`, `/cms/reset-password`, `/cms/magic-link` and `/cms/two-factor/enrol`. A link's token is never written into the page, and the document sends no referrer.
