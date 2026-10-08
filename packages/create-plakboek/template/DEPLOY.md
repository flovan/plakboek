# Deploying

Every push to `main` that passes CI is built into an image, pushed to GitHub's container registry and rolled out to your server by `.github/workflows/deploy.yml`. Nobody runs a command by hand after the one-time setup below.

The server runs Docker Compose with three services:

- `app`, this site, built from the `Dockerfile`.
- `postgres`, version 17, with its data in a named volume and no published port.
- `caddy`, which gets and renews the TLS certificate, compresses responses, refuses oversized request bodies (setup form posts over 16 KiB and anything over 64 MB) and forwards requests to the app. It keeps the `Cache-Control` and `ETag` headers the app sets and caches nothing itself.

A fourth service, `migrate`, is a one-off container that applies the CMS migrations. The app never migrates when it starts.

## What a deploy does

`scripts/deploy.sh` runs these steps on the server, each one only if the one before it succeeded:

1. Copy `compose.yaml` to the deploy directory.
2. Pull the new image.
3. Start Postgres and wait until it is healthy.
4. Run the `migrate` service once.
5. Recreate `app` and `caddy` and wait until the app reports healthy.
6. Record the deployed image as the `PLAKBOEK_IMAGE` line of `.env`, so compose commands you run in the deploy directory use the image that is running. A failed deploy keeps the previous line.

If the migration fails, the deploy stops with a non-zero exit and the previous app container keeps running and serving. Migrations are forward-only and additive, so the old code keeps working against the new schema while the new one starts. Caddy holds incoming requests for up to 15 seconds while the app container is replaced, so visitors see no error during the restart.

Deploys run one at a time and in push order. The whole workflow runs in the `production-deploy` group, so a push waits for the previous deploy to finish before its own run starts, while the CI workflow still runs on every push straight away. When several pushes arrive during a deploy, only the newest one waits and the runs in between are cancelled, because the newest commit contains them. Before it touches the server, the deploy job checks that its commit is still the tip of `main` and skips the deploy otherwise, so an older commit never replaces a newer one, not even when you re-run an old run by hand. The migration runner also holds a database lock.

A commit that another workflow pushes with its `GITHUB_TOKEN` does not start the Deploy workflow, because GitHub starts no workflow for a push made with that token. Pushes by people and by GitHub Apps, such as a dependency bot, do.

## Prepare the server

You need a Linux server with a public address and DNS for your domain pointing at it.

1. Install Docker Engine with the Compose plugin (Compose 2.24 or newer).
2. Create a user for deploys, for example `deploy`, and add it to the `docker` group. Give it an SSH key pair that is used for nothing else.
3. Create the deploy directory, for example `/srv/site`, owned by that user. Use an absolute path with letters, digits, `.`, `_`, `-` and `/` only.
4. Open ports 80 and 443.
5. Create `.env` in the deploy directory. It is the only place the production secrets live. It is never committed and never built into the image. The deploy script adds and maintains a `PLAKBOEK_IMAGE` line in this file, so leave that line to the script. The file must belong to the deploy user and be readable by nobody else, because the deploy script reads and rewrites it. If you create it as root, hand it over with `chown deploy: /srv/site/.env && chmod 600 /srv/site/.env`. The deploy script checks this before it changes anything on the server, and stops with that fix when the file is missing or the deploy user cannot read and write it.

```sh
POSTGRES_USER=plakboek
POSTGRES_PASSWORD=<a long random value without special characters>
POSTGRES_DB=plakboek

# The database is the `postgres` service of this stack.
DATABASE_URL=postgres://plakboek:<the same password>@postgres:5432/plakboek

# The public origin of the site, with https and no path.
PLAKBOEK_URL=https://www.example.com
# The host name Caddy serves and gets a certificate for.
SITE_ADDRESS=www.example.com

# At least 32 random characters, unique to this installation.
PLAKBOEK_SECRET=<output of `pnpm --silent secret` on your computer>

PLAKBOEK_SMTP_HOST=smtp.example.com
PLAKBOEK_SMTP_PORT=587
PLAKBOEK_SMTP_SECURE=false
PLAKBOEK_SMTP_USER=<smtp user>
PLAKBOEK_SMTP_PASS=<smtp password>
PLAKBOEK_MAIL_FROM=no-reply@example.com
```

Generate the passwords with `openssl rand -hex 24`. A password with `@`, `:` or `/` in it must be percent-encoded inside `DATABASE_URL`, which is why hexadecimal is easiest.

## Configure GitHub

In the repository settings:

1. Create an environment named `production`. Add required reviewers to it if you want a human to approve each deploy.
2. Add these secrets to the `production` environment:
   - `DEPLOY_SSH_KEY`: the private key of the deploy user.
   - `DEPLOY_KNOWN_HOSTS`: the server's host key, so the first connection cannot be intercepted. Record it once from your computer and paste the output:

     ```sh
     ssh-keyscan -t ed25519 your.server.example
     ```

     Compare it with the fingerprint your hosting provider shows for the server. Add `-p <port>` when SSH listens on another port.

     Replace `your.server.example` with exactly the value you give `DEPLOY_HOST`: the same IP address in both places, or the same host name in both. The deploy script looks the key up by that value, so a key recorded for the IP address does not match a host name, and the other way round.

3. Add these variables to the same environment:
   - `DEPLOY_HOST`: the server's address, exactly as you scanned it for `DEPLOY_KNOWN_HOSTS`.
   - `DEPLOY_USER`: the deploy user.
   - `DEPLOY_PATH`: the absolute deploy directory.
   - `DEPLOY_PORT`: only when SSH does not listen on 22.

The deploy script refuses to connect to a host whose key does not match `DEPLOY_KNOWN_HOSTS`.

## The first deploy

1. Push to `main` and wait for the workflow. The first run pulls the base images and takes a few minutes. If the `production` environment has required reviewers, approve this first run when you can create the administrator right after it.
2. From the moment this deploy finishes until the first account exists, `/cms/setup` is open to anyone who reaches it, and whoever submits it first becomes the superadmin. The page closes for good once an account exists. Keep that window short: as soon as the workflow run finishes, create the administrator on the server from the command line.

   ```sh
   cd /srv/site
   printf '%s' 'the password' | docker compose -f compose.yaml run --rm -T app \
     ./node_modules/.bin/plakboek bootstrap --name 'Your name' \
     --email you@example.com --password-stdin
   ```

3. Check that the account is yours. The command prints `Created superadmin` followed by your address, and `/cms/setup` on your domain now answers with a 404 like any unknown page. The command also published the starter home page.
4. If the command instead reports that the installation already has users, someone else created the first account before you. On a new installation, start over: in the deploy directory run `docker compose -f compose.yaml down --volumes`, which deletes the database and the stored certificates, then re-run the newest Deploy workflow run and repeat steps 2 and 3. Never do this on an installation that holds content.
5. Open your site. If it has no certificate, see [Troubleshooting](#troubleshooting).

## Pulling the image

The workflow logs the server in to `ghcr.io` with the job's own short-lived token, so no long-lived credential is stored on the server. If the server cannot pull your image with that token, for example because of the organisation's package settings, create a personal access token with only the `read:packages` scope, run `docker login ghcr.io -u <user> --password-stdin` once on the server and give it that token. The stored login then keeps working between deploys.

## A managed database instead

`DATABASE_URL` is just a connection string. To use a managed Postgres, remove the `postgres` service from `compose.yaml`, the `depends_on` entries that name it and the `POSTGRES_*` variables, and put the provider's address in `DATABASE_URL`.

One rule applies: migrations take a session-level lock, so they need a direct connection and never a transaction-mode pooler. If `DATABASE_URL` points at a pooler, add `DATABASE_MIGRATION_URL` with the direct address to `.env`. The `migrate` service uses it and the app keeps using `DATABASE_URL`.

## Backups

This release ships no backup tooling. Nothing copies your database or your uploads anywhere. Until backups are part of the CMS, take your own: for the bundled Postgres, a scheduled `docker compose -f compose.yaml exec -T postgres pg_dump -U plakboek plakboek` written to storage off the server is a start, and a managed database brings its own automated backups.

## Run it on your computer

`docker build -t plakboek-app:local .` builds the image. With a `.env` in place, `docker compose -f compose.yaml up -d` starts the whole stack. For day-to-day development you only need the database: `docker compose up -d postgres`, which also publishes it on `127.0.0.1:5432` through `compose.override.yaml`.

## Troubleshooting

### The site has no certificate

When `curl` fails with `tlsv1 alert internal error`, Caddy has no certificate for that name yet. Look at what Caddy tried:

```sh
cd /srv/site
docker compose -f compose.yaml logs caddy
```

The `obtain` and `challenge` lines show the attempts. Their `identifier` field is the name Caddy requests a certificate for, so a typo in `SITE_ADDRESS` shows up there.

The A record, and the AAAA record if you set one, must point at the server's own address. On Hetzner, for example, that is the `::1` address of the server's /64, not the /64 itself. Ports 80 and 443 must be open.

After you fix `.env`, recreate the containers so they read it:

```sh
docker compose -f compose.yaml up -d --force-recreate app caddy
```
