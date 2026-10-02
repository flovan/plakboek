---
'@plakboek/pages': minor
---

`publishPage` now refuses a default-locale page whose public path would lead to a different address (a path starting with an enabled locale code, such as `nl/x` or `en/about`) with the new `PageAddressUnreachableError`, instead of publishing a page nobody can reach. The public-path mapping is split into its own module and `toPublicPagePath`'s documentation no longer claims it inverts the matcher for every address.
