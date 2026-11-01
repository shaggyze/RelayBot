FROM node:20-bookworm-slim
# build tools only needed if better-sqlite3 has no prebuilt binary; kept for safety
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
# /data holds the persistent sqlite db (mounted as a volume)
VOLUME ["/data"]
CMD ["node", "index.js"]
