# ---- Build stage ----
FROM node:20-slim AS build
WORKDIR /app

# pnpm is the package manager (package-lock.json is not used anymore)
RUN npm install -g pnpm@10 --no-audit --no-fund

# Copy manifests first for better layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# Copy sources
COPY packages/shared packages/shared
COPY apps/web apps/web

# Build shared package (types) then the web app
RUN pnpm --filter @prompt-forge/shared build \
    && pnpm --filter @prompt-forge/web build

# ---- Runtime stage ----
FROM nginx:alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
