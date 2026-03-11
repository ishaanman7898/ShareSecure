# ── Stage 1: dependencies ─────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# better-sqlite3 needs python + build tools for native compilation
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: runtime image ────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# create a non-root user for security
RUN addgroup -g 1001 -S sharesecure && \
    adduser  -u 1001 -S sharesecure -G sharesecure

# copy built deps and application files
COPY --from=deps /app/node_modules ./node_modules
COPY server  ./server
COPY public  ./public
COPY package.json ./

# data directory (mounted as a volume)
RUN mkdir -p /app/data/uploads && \
    chown -R sharesecure:sharesecure /app

USER sharesecure

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# persistent storage for DB + uploaded files
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/ > /dev/null || exit 1

CMD ["node", "server/index.js"]
