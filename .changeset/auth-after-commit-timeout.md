---
'@plakboek/auth': minor
'@plakboek/cache': minor
---

After-commit callbacks are now bounded: each one that has not settled within `afterCommitTimeoutMs` (default 10 seconds) is reported through `onAfterCommitFailed` as the new `AfterCommitTimeoutError` and `run` moves on, so a hung downstream layer cannot hang a committed write. The default failure log also states how many cache layers failed and which, using the new `CachePurgeError.failedLayers`. A timed-out or failed purge is still not retried.
