# Contexto de build: raíz del repositorio (Railway: Root Directory vacío).
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/domain/package.json packages/domain/
COPY packages/db/package.json packages/db/
COPY tools/check-no-cad/package.json tools/check-no-cad/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@sim/web..."
COPY packages/domain packages/domain
COPY apps/web apps/web
RUN pnpm --filter @sim/web build

FROM nginx:1.29-alpine
ENV PORT=8080
COPY apps/web/docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY apps/web/docker/40-app-config.sh /docker-entrypoint.d/40-app-config.sh
RUN chmod +x /docker-entrypoint.d/40-app-config.sh
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
