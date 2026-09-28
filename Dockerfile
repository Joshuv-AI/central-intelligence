# Central Intelligence — full system, linux/arm64 (Oracle Ampere A1).
#
# Stage 1 builds the Vite/Cesium frontend. Stage 2 is the Node backend,
# which serves the built frontend as static files (same origin, port 3001).

# ---- Stage 1: frontend build ----
FROM node:22-alpine AS frontend-build

WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci && npm cache clean --force
COPY frontend ./
# Public client-side CARTO basemap key (ships in the browser bundle by design —
# every visitor's tile URLs contain it; restrict by domain in the CARTO dashboard).
ARG VITE_CARTO_KEY
RUN npm run build

# ---- Stage 2: backend runtime ----
FROM node:22-alpine

WORKDIR /app

# Install backend deps first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY LICENSE ./
COPY --from=frontend-build /frontend/dist ./public
COPY frontend/LICENSE ./public/frontend-LICENSE.txt

# Run as non-root; state dir must be writable.
RUN addgroup -S app && adduser -S app -G app \
  && mkdir -p /app/data && chown -R app:app /app
USER app

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/health > /dev/null || exit 1

CMD ["node", "src/index.js"]
