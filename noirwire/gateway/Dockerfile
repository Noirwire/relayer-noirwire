# Relayer gateway. Node 22 on Alpine, pinned by digest (the node:22-alpine manifest list).
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# Exactly the locked dependencies, none of the development ones, no install scripts.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY migrations ./migrations
# The operator's reset of a paused customer; it runs against the same database.
COPY scripts/reset-failures.mjs ./scripts/reset-failures.mjs
USER node
# PORT, RPC_URL, STORE, DATABASE_URL, CUSTOMERS_FILE, PLATFORM_PAYMENT_OWNERS and the per-customer secrets come from the
# service's variables. The customers file is mounted or baked in by the deployment, never here.
CMD ["node", "src/main.mjs"]
