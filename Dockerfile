# =============================================================================
# OctoDeck Main Service - Multi-stage Dockerfile
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Dependencies - Install all dependencies (cache-friendly layer)
# -----------------------------------------------------------------------------
FROM node:22-slim AS dependencies

# Use Tsinghua mirror for apt
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources && \
    sed -i 's|security.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources

# Install build dependencies for native modules (better-sqlite3, node-pty)
# git is required for npm packages installed from Git repos
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    gcc \
    libc6-dev \
    libsqlite3-dev \
    git \
    openssh-client \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package.json files first for better layer caching
COPY package.json ./
COPY web/package.json ./web/
COPY container/agent-runner/package.json ./container/agent-runner/

# Configure npm to use taobao registry
RUN npm config set registry https://registry.npmmirror.com

# Force git to use HTTPS instead of SSH for GitHub (avoids SSH auth issues)
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

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
# Stage 2b: Go daemon builder - Compile octodeck-daemon with go.mod version
# -----------------------------------------------------------------------------
FROM golang:1.21-bookworm AS daemon-builder

WORKDIR /app/client/octodeck-daemon

# Build Go daemon
COPY client/octodeck-daemon/ ./
RUN GOPROXY=https://goproxy.cn,direct go build -o octodeck-daemon .

# -----------------------------------------------------------------------------
# Stage 3: Production - Minimal runtime image
# -----------------------------------------------------------------------------
FROM node:22-slim AS production

# Use Tsinghua mirror for apt
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources && \
    sed -i 's|security.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources

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

# Copy Go daemon binary
COPY --from=daemon-builder /app/client/octodeck-daemon/octodeck-daemon ./client/octodeck-daemon/octodeck-daemon

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
