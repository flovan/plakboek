---
'create-plakboek': minor
---

First release of `create-plakboek`. `npx create-plakboek [dir]` asks for a project directory, site name, default locale and additional locales (each also a flag, with `--yes` to accept the defaults), writes a Plakboek host project from the template bundled in the package, initialises git and installs with pnpm. Answers reach generated files only as JSON-escaped literals, existing files are never overwritten, and a failed install keeps the project and says how to retry. Requires Node.js 22.22 or later.
