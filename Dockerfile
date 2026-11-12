# syntax=docker/dockerfile:1
#
# One image for the ledger (api, worker, reconcile, migrate: same image,
# different command) and a second, tiny image for the mock provider.
#
#   docker build --target app            -t ledger-service:local .
#   docker build --target mock-provider  -t ledger-mock-provider:local .
#
# Stages:
#   deps       all dependencies (incl. dev), to compile TypeScript
#   build      tsc -> dist/  (JavaScript only)
#   prod-deps  production dependencies only
#   app        node + prod node_modules + dist/, as a non-root user
#   mock-provider  node + 4 compiled files, no node_modules at all

ARG NODE_IMAGE=node:22.23.5-alpine3.24

FROM ${NODE_IMAGE} AS deps
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY mock-provider ./mock-provider
RUN npx tsc -p tsconfig.build.json

FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# A runtime base without the package managers: nothing at run time needs npm,
# and every binary we leave out is one less thing to patch or abuse.
FROM ${NODE_IMAGE} AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production

FROM runtime AS app
WORKDIR /app
# Files are owned by root and only readable by the app user: the running
# process cannot modify its own code.
COPY package.json ./
COPY --from=prod-deps /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
# The migration runner and /readyz both look for migrations/ next to dist/src.
COPY migrations ./dist/migrations
USER node
EXPOSE 3000 9101
# `node` directly (not npm/npx): SIGTERM from Docker/Kubernetes reaches the app.
CMD ["node", "dist/src/server.js"]

FROM runtime AS mock-provider
WORKDIR /app
RUN printf '{"type":"module","private":true}\n' > package.json
COPY --from=build /build/dist/mock-provider ./mock-provider
USER node
EXPOSE 4100
CMD ["node", "mock-provider/server.js"]
