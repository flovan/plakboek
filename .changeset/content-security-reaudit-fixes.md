---
'@plakboek/content': patch
---

Close two high-severity threats a security re-audit found still open.

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
