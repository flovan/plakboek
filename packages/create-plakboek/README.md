# create-plakboek

Scaffold a Plakboek host project.

```sh
npx create-plakboek my-site
```

The command writes a project from the starter template that ships inside this
package. Nothing is fetched from the network to build the project; only the
dependency install that follows talks to the registry.

Requires Node.js 22.22 or later and [pnpm](https://pnpm.io/installation).

## What it asks

| Prompt                                               | Flag               | Default                          |
| ---------------------------------------------------- | ------------------ | -------------------------------- |
| Project directory                                    | `[dir]` or `--dir` | `my-plakboek-site`               |
| Site name (1 to 200 characters)                      | `--site-name`      | the directory name in Title Case |
| Default locale                                       | `--locale`         | `en`                             |
| Additional locales (comma-separated, blank for none) | `--locales`        | `nl` with `--yes`; blank is none |

A flag skips its prompt. When standard input is not a terminal, every value
must come from a flag or from `--yes`; a missing value fails with
`Error: {flag} is required when input is not interactive.` instead of waiting
for input.

Other options:

- `--yes` (`-y`) accepts every default without asking.
- `--timezone <name>` sets the site's IANA time zone (default: this machine's).
- `--skip-install` skips `pnpm install` and the formatter run, and adds
  `pnpm install` to the printed next steps.
- `--help` (`-h`) and `--version` (`-v`).

## What it does

1. Refuses a directory that already holds files. Files are created
   exclusively, so nothing is ever overwritten.
2. Copies the starter, filling the site name, locales, time zone, package name
   and the version of the `@plakboek/*` packages (the generated project pins
   them to this CLI's own version).
3. Runs `git init`, then `pnpm install`, then the project's formatter.

If the install fails, the project directory is kept and the command tells you
to run `pnpm install` there. The command never deletes what it wrote.

## Exit codes

| Code | Meaning                                                           |
| ---- | ----------------------------------------------------------------- |
| 0    | The project was created                                           |
| 1    | Unsupported Node.js, pnpm missing, or a failure while creating it |
| 2    | Bad usage: an unknown flag, an invalid answer or a missing value  |
