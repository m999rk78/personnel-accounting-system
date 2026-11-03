FROM node:22-bookworm-slim
WORKDIR /opt/maintenance
RUN groupadd --system --gid 1001 maintenance && useradd --system --uid 1001 --gid maintenance maintenance
COPY --chown=node:node scripts/maintenance-fallback.mjs ./scripts/maintenance-fallback.mjs
COPY --chown=node:node public/maintenance.html ./public/maintenance.html
COPY scripts/maintenance-assets.mjs ./scripts/maintenance-assets.mjs
ENV HOST=0.0.0.0 PORT=8099 MAINTENANCE_STATIC_ARCHIVE=/opt/maintenance/static
USER 1001:1001
EXPOSE 8099
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8099/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "scripts/maintenance-fallback.mjs"]
