# ---- Build stage ----
FROM node:20-slim AS build
WORKDIR /app

# Copy manifests first for better layer caching
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN npm ci

# Copy sources
COPY packages/shared packages/shared
COPY apps/web apps/web

# Build shared package (types) then the web app
RUN npm run build --workspace @prompt-forge/shared \
    && npm run build --workspace @prompt-forge/web

# ---- Runtime stage ----
FROM nginx:alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
