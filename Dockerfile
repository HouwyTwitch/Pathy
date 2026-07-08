# Single image for both the Pathy server and bots — the compose file picks
# the command. Built from the repo root.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY shared ./shared
COPY server ./server
COPY bots ./bots

# Writable state dirs (mounted as volumes in compose). /data/blobs must exist
# in the image with the right owner: a named volume mounted over a missing
# path is created root-owned, and the server (running as `node`) could then
# not store attachments.
RUN mkdir -p /data/blobs && chown -R node:node /data

USER node
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server/src/index.js"]
