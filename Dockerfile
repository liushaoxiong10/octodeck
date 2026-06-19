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
# Stage 2b: Go daemon builder - Cross-compile octodeck-daemon for 4 platforms
#   支持的平台（与 src/routes/daemon.ts SUPPORTED_PLATFORMS 保持一致）:
#     darwin/amd64, darwin/arm64, linux/amd64, linux/arm64
#   产物固定输出到 /app/client/octodeck-daemon/dist/octodeck-daemon-{os}-{arch}
# -----------------------------------------------------------------------------
FROM golang:1.24-bookworm AS daemon-builder

WORKDIR /src

# Prefetch modules for better layer cache
COPY client/octodeck-daemon/go.mod client/octodeck-daemon/go.sum ./
COPY client/octodeck-daemon/third_party/acp-adapter/go.mod ./third_party/acp-adapter/go.mod
RUN GOPROXY=https://goproxy.cn,direct go mod download

# Copy source
COPY client/octodeck-daemon/ ./

# Cross-compile all four targets (CGO_ENABLED=0 = pure static binaries, compatible with alpine/slim)
RUN set -eux; \
    mkdir -p /out/dist; \
    for pair in darwin/amd64 darwin/arm64 linux/amd64 linux/arm64; do \
      goos="${pair%/*}"; \
      goarch="${pair#*/}"; \
      out="/out/dist/octodeck-daemon-${goos}-${goarch}"; \
      CGO_ENABLED=0 GOOS="${goos}" GOARCH="${goarch}" \
        go build -trimpath -ldflags="-s -w" -o "${out}" ./cmd/octodeck-daemon; \
    done; \
    # 为旧路由 /api/daemon/octodeck-daemon-bin (无后缀) 准备一个当前平台的默认副本
    cp /out/dist/octodeck-daemon-linux-amd64 /out/octodeck-daemon; \
    ls -lh /out /out/dist

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

# Copy Go daemon binaries (4 platforms + legacy single-binary fallback)
COPY --from=daemon-builder /out/octodeck-daemon ./client/octodeck-daemon/octodeck-daemon
COPY --from=daemon-builder /out/dist/         ./client/octodeck-daemon/dist/
COPY client/octodeck-daemon/cmd/octodeck-daemon/VERSION ./client/octodeck-daemon/cmd/octodeck-daemon/VERSION

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
