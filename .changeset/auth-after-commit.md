---
'@plakboek/auth': minor
---

Audited mutations now receive a context whose `afterCommit` registers work that runs only after the transaction has committed, in order, awaited and isolated from the mutation's result.
