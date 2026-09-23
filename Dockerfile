# ShareSecure self-hosted image
#   docker run -d --name sharesecure -p 3000:3000 -v sharesecure-data:/app/data \
#     $(docker build -q https://github.com/ishaanman7898/ShareSecure.git)

FROM node:20-bookworm-slim AS deps
WORKDIR /app
# build tools only in this stage, in case better-sqlite3 has no prebuilt binary for the platform
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    ENV_FILE=/app/data/.env \
    SHARESECURE_DOCKER=1
COPY --from=deps /app/node_modules ./node_modules
COPY package.json .env.example ./
COPY server ./server
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME /app/data
EXPOSE 3000
CMD ["node", "server/index.js"]
