FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# Lockfile required, no fallback: a stale or missing one must fail the build
# loudly rather than silently resolving fresh dependency versions.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY src ./src
COPY public ./public
COPY sample-data.json ./

# SQLite file lives here — mount a volume to keep connections across deploys.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

USER node
EXPOSE 3000
ENV PORT=3000 DB_PATH=/app/data/readmeify.db

CMD ["node", "src/server.js"]
