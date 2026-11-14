# syntax=docker/dockerfile:1

# Refill job, a run-to-completion Node process. Base image pinned by digest.
# Production dependencies only.
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Run: the source and its production dependencies, as a user that owns nothing
# in the image. The job writes nothing to disk, so no writable path is needed.
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS run
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
# Exec form so SIGTERM reaches node itself.
CMD ["node", "src/main.mjs"]
