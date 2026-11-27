# AuMeet AI agent (LiveKit Agents worker).
# Debian (glibc) on purpose: @livekit/rtc-node's native bindings and onnxruntime have no musl/Alpine builds.

# ---------- build ----------
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV MONGOMS_DISABLE_POSTINSTALL=1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- runtime ----------
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# CA certificates for TLS to LiveKit Cloud, Deepgram, Google and Cartesia.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

USER node
# The worker connects out to LiveKit; nothing needs to reach it from outside.
CMD ["node", "dist/main.js", "start"]
