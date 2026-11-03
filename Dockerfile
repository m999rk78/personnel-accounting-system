FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS builder
WORKDIR /app
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
WORKDIR /app
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs personnel
COPY --from=builder --chown=personnel:nodejs /app/dist/standalone ./
COPY --from=builder --chown=personnel:nodejs /app/drizzle-postgres ./drizzle-postgres
COPY --from=builder --chown=personnel:nodejs /app/scripts/apply-postgres-migrations.mjs ./scripts/apply-postgres-migrations.mjs
COPY --from=builder --chown=personnel:nodejs /app/scripts/start-production.mjs ./scripts/start-production.mjs
COPY --from=builder --chown=personnel:nodejs /app/scripts/maintenance-gateway.mjs ./scripts/maintenance-gateway.mjs
COPY --from=builder --chown=personnel:nodejs /app/scripts/maintenance-control.mjs ./scripts/maintenance-control.mjs
COPY --from=builder --chown=personnel:nodejs /app/scripts/maintenance-assets.mjs ./scripts/maintenance-assets.mjs
COPY --from=builder --chown=personnel:nodejs /app/public/maintenance.html ./public/maintenance.html
COPY --from=dependencies --chown=personnel:nodejs /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
RUN mkdir -p /app/.runtime && chown personnel:nodejs /app/.runtime
USER personnel
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]
CMD ["node", "scripts/start-production.mjs"]
