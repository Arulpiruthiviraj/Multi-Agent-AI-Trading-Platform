# Multi-stage build. better-sqlite3 needs a native rebuild step, so the deps stage
# installs full build tooling; the runtime stage stays slim and copies only the
# already-built artifacts + production node_modules across.
FROM node:24.18.0-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build

FROM node:24.18.0-bookworm-slim AS prod-deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24.18.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The official node:*-slim images already ship a non-root `node` user (uid/gid 1000) - reused
# here rather than creating a new one. --chown ensures that user actually owns what it needs to
# read/write; without it, files copied by the (root) COPY instruction stay root-owned and the
# container would fail at runtime the moment USER node tries to read node_modules or write data/.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node drizzle ./drizzle

# data/ holds argus.db (SQLite, WAL mode) and the auto-generated encryption key - must be a
# volume in any real deployment (see docker-compose.yml) or every restart starts from empty.
# docker-compose.yml mounts this as a named volume, not a bind mount - Docker copies this
# directory's ownership into the volume on first creation, so the chown here is what makes the
# volume itself writable by `node` too, not just this build layer.
RUN mkdir -p data && chown node:node data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)throw new Error(r.status)}).catch(()=>process.exit(1))"

USER node
CMD ["node", "dist/server.cjs"]
