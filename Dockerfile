# Pinned by exact tag and digest (multi-arch index for node:24.22.2-trixie-slim, resolved 2026-10-31). Refresh periodically.
FROM node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 11.10.0 has no prebuilt binary for node 24, so the apt toolchain fallback compiles it.
# Install the toolchain only when the prebuilt download fails.
RUN npm ci --omit=dev || (apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci --omit=dev && rm -rf /var/lib/apt/lists/*)

FROM node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446
ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/dashboard.db
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown node:node /data
# The app runs with node only; drop the bundled package-manager tooling.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
