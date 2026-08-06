# ---- Build stage ----
FROM node:20-slim AS build
WORKDIR /app

# Install build tools in case prebuilt binaries for better-sqlite3 are unavailable
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy manifests first for better layer caching
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci

# Copy sources
COPY packages/shared packages/shared
COPY apps/api apps/api

# Build shared package (types) then the API
RUN npm run build --workspace @prompt-forge/shared \
    && npm run build --workspace @prompt-forge/api

# ---- Runtime stage ----
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Copy built workspace, node_modules (includes the compiled native addon), and manifests
COPY --from=build /app/package.json /app/tsconfig.base.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/api ./apps/api

RUN mkdir -p /app/apps/api/data
WORKDIR /app/apps/api

# Persist SQLite data via a volume
VOLUME ["/app/apps/api/data"]

EXPOSE 3000
CMD ["node", "dist/index.js"]
