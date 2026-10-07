# syntax=docker/dockerfile:1
#
# Production image for this site. The build context is the whole project minus
# .dockerignore, and the image holds no credentials: the runtime environment
# comes from the .env file on the server (see compose.yaml and DEPLOY.md).

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

# Every dependency, then the production build.
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
# NODE_ENV only applies to the build step: it must not skip the dev dependencies
# of the install above, and it keeps the development client out of the output.
RUN NODE_ENV=production pnpm run build

# Production dependencies only.
FROM base AS prod-deps
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm/store

# What runs: the server, the build, and the files `plakboek bootstrap` loads
# (the config imports the blocks and the seed).
FROM node:22-slim AS runtime
WORKDIR /app
ARG GIT_SHA=unknown
ENV NODE_ENV=production \
    PLAKBOEK_BUILD_ID=$GIT_SHA
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/package.json /app/server.ts /app/plakboek.config.ts /app/seed.ts /app/tsconfig.json ./
COPY --from=build /app/blocks ./blocks
USER node
EXPOSE 3000
CMD ["node", "server.ts"]
