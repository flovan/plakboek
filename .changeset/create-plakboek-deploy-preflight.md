---
'create-plakboek': patch
---

The starter's deploy script now checks the server before it changes anything there. The deploy directory must exist and be writable, and `.env` must be readable and writable by the deploy user. Otherwise the script stops with a message naming the `mkdir`, `chown` or `chmod` command that fixes it. `DEPLOY.md` now says the deploy user owns `.env`, that a commit another workflow pushes with `GITHUB_TOKEN` starts no deploy, that the host scanned for `DEPLOY_KNOWN_HOSTS` must be exactly `DEPLOY_HOST`, and how to find out why Caddy has no certificate.
