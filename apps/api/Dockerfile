# Contexto de build: raíz del repositorio (Railway: Root Directory vacío).
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/domain/package.json packages/domain/
COPY packages/db/package.json packages/db/
COPY tools/check-no-cad/package.json tools/check-no-cad/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@sim/api..."

FROM base
ENV NODE_ENV=production
COPY --from=deps /app /app
COPY packages/domain/src packages/domain/src
COPY apps/api/src apps/api/src
USER node
EXPOSE 8080
CMD ["node", "apps/api/src/server.ts"]
