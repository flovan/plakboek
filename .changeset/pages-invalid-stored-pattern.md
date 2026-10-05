---
'@plakboek/pages': minor
---

`resolveVisitorPage` now returns an `invalid-pattern` resolution (carrying the `PageUrlPatternError`) when the stored page URL pattern no longer parses, for example one written before pattern literals were restricted, instead of throwing on every request.
