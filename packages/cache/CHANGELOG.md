# @plakboek/cache

## 0.5.1

## 0.5.0

## 0.2.0

### Minor Changes

- [#13](https://github.com/flovan/plakboek/pull/13) [`e689d61`](https://github.com/flovan/plakboek/commit/e689d614e8dee1bd789b95399487b5af37fa34e5) Thanks [@flovan](https://github.com/flovan)! - After-commit callbacks are now bounded: each one that has not settled within `afterCommitTimeoutMs` (default 10 seconds) is reported through `onAfterCommitFailed` as the new `AfterCommitTimeoutError` and `run` moves on, so a hung downstream layer cannot hang a committed write. The default failure log also states how many cache layers failed and which, using the new `CachePurgeError.failedLayers`. A timed-out or failed purge is still not retried.

- [#13](https://github.com/flovan/plakboek/pull/13) [`47d17e5`](https://github.com/flovan/plakboek/commit/47d17e565631763e401e9cea754226519e01ca89) Thanks [@flovan](https://github.com/flovan)! - Add the @plakboek/cache package: cache tag vocabulary, the cache backend and
  invalidator contract, and a bounded in-process cache with ticket-guarded fills.
