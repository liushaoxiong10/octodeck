# =============================================================================
# OctoDeck Main Service - Multi-stage Dockerfile
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Dependencies - Install all dependencies (cache-friendly layer)
# -----------------------------------------------------------------------------
FROM node:22-slim AS dependencies

# Install build dependencies for native modules (better-sqlite3, node-pty)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    gcc \
    libc6-dev \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package.json files first for better layer caching
COPY package.json ./
COPY web/package.json ./web/
COPY container/agent-runner/package.json ./container/agent-runner/

# Install all dependencies
RUN npm install && \
    cd web && npm install && \
    cd ../container/agent-runner && npm install

# -----------------------------------------------------------------------------
# Stage 2: Builder - Compile all projects
# -----------------------------------------------------------------------------
FROM dependencies AS builder

WORKDIR /app

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/
COPY shared/ ./shared/
COPY config/ ./config/

COPY web/ ./web/

COPY container/agent-runner/ ./container/agent-runner/

# Build all projects (backend + web + agent-runner)
RUN npm run build:all

# -----------------------------------------------------------------------------
# Stage 3: Production - Minimal runtime image
# -----------------------------------------------------------------------------
FROM node:22-slim AS production

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    sqlite3 \
    libsqlite3-0 \
    python3 \
    git \
    ca-certificates \
    curl \
    procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Create data directory (will be mounted as volume)
RUN mkdir -p /app/data

# Copy backend production dependencies and built artifacts
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

# Copy built frontend
COPY --from=builder /app/web/dist ./web/dist

# Copy agent-runner built artifacts
COPY --from=builder /app/container/agent-runner/dist ./container/agent-runner/dist
COPY --from=builder /app/container/agent-runner/prompts ./container/agent-runner/prompts
COPY --from=dependencies /app/container/agent-runner/node_modules ./container/agent-runner/node_modules
COPY --from=builder /app/container/agent-runner/package.json ./container/agent-runner/

# Copy config directory (mount allowlist etc.)
COPY --from=builder /app/config ./config

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:${WEB_PORT:-3000}/api/health || exit 1

# Expose web port
EXPOSE 3000

# Set environment defaults
ENV NODE_ENV=production
ENV WEB_PORT=3000
ENV TZ=Asia/Shanghai
ENV DATA_DIR=/app/data

# Start the service
CMD ["node", "dist/index.js"]
