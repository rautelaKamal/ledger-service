# syntax=docker/dockerfile:1
#
# The web app: Next.js built as a self-contained server (output: 'standalone').
#
#   docker build -t ledger-web:local web/
#
# Stages:
#   deps     every dependency (incl. dev: TypeScript, Tailwind are build-time only)
#   build    next build -> .next/standalone (server.js + only the modules it needs)
#   runtime  node + the standalone server + static assets, as a non-root user
#
# Nothing secret goes in at build time: the ledger's URLs, the session secret and
# the assistant mode arrive as environment variables when the container starts.

ARG NODE_IMAGE=node:22.23.5-alpine3.24

FROM ${NODE_IMAGE} AS deps
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx next build

FROM ${NODE_IMAGE} AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3200 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /build/.next/standalone ./
COPY --from=build /build/.next/static ./.next/static
COPY --from=build /build/public ./public
USER node
EXPOSE 3200
# `node` directly: SIGTERM from Docker/Kubernetes reaches the server.
CMD ["node", "server.js"]
