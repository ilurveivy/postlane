# --- build stage -----------------------------------------------------------
# Native modules are built for the image's Linux architecture, never copied in
# from the host, so an amd64/arm64 image is reproducible from any machine.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# --- runtime stage ---------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
# `tar` is used by the backup/restore scripts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tar \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node scripts ./scripts
# server/*.js imports shared domain logic directly from src/*.js.
COPY --chown=node:node src/*.js ./src/
ENV NODE_ENV=production \
    PORT=4173 \
    DATA_DIR=/data \
    DISABLE_SLEEP_GUARD=true \
    # A published port reaches the container's eth0, never its loopback.
    BIND_HOST=0.0.0.0
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4173
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js", "--production"]
