# Angular app served by nginx, which also proxies /api to the API container
# (same origin in the browser, exactly like the dev proxy).

# ---------- build ----------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx ng build --configuration production

# ---------- runtime ----------
FROM nginx:1.27-alpine
# Rendered to /etc/nginx/conf.d/default.conf at start-up with LIVEKIT_CSP_HOSTS substituted.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
ENV LIVEKIT_CSP_HOSTS=*.livekit.cloud
ENV NGINX_ENVSUBST_FILTER=^LIVEKIT_CSP_HOSTS$
COPY --from=build /app/dist/web/browser /usr/share/nginx/html
EXPOSE 80
# 127.0.0.1, not localhost: busybox resolves localhost to ::1 but nginx listens on IPv4.
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
