# @plakboek/content

## 0.2.0

### Minor Changes

- [#7](https://github.com/flovan/plakboek/pull/7) [`37c9d53`](https://github.com/flovan/plakboek/commit/37c9d5322e510de13ca0c42beb4a1e7e9d0ed5b5) Thanks [@flovan](https://github.com/flovan)! - Add the @plakboek/content package scaffold with its real-Postgres
  integration test harness and a pinned zod validation contract.

### Patch Changes

- [#9](https://github.com/flovan/plakboek/pull/9) [`0acd33e`](https://github.com/flovan/plakboek/commit/0acd33e837dc1cd358ceab44bc6789428d17c9ff) Thanks [@flovan](https://github.com/flovan)! - Close two high-severity threats a security re-audit found still open.

  The `short_text` pattern guard now refuses two adjacent atoms that can each
  repeat more than once (`.*.*`), a catastrophic backtracking shape it did not
  model. It also stops running a user-authored pattern once a value is already
  past its length cap, because zod does not stop at the first failing check, so
  the cap bounded the stored value but never bounded the match.

  A relative `url` value is now decided by resolving it against a probe origin
  and requiring it to land on that same origin. The previous rule excluded
  backslash and only backslash, and the WHATWG URL parser strips ASCII TAB, LF
  and CR before parsing, so `/\t/evil.com` was accepted and resolves to another
  origin. Resolving closes that whole class rather than one character at a time.

- Updated dependencies [[`6005d92`](https://github.com/flovan/plakboek/commit/6005d92dc7be5a9aa5a62da81201a31fe18a82ff), [`113c783`](https://github.com/flovan/plakboek/commit/113c7839871e9e84d681ea2211dcd2f793f336c2)]:
  - @plakboek/db@0.3.0
  - @plakboek/permissions@0.3.0
  - @plakboek/auth@0.2.1
