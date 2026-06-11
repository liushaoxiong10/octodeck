import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Variables } from '../web-context.js';
import { LATEST_DAEMON_VERSION } from '../agent-link/registry.js';

const DAEMON_VERSION = LATEST_DAEMON_VERSION;
const DAEMON_UPDATE_COMMAND =
  '~/.octodeck/daemon/bin/octodeck-daemon update -config ~/.octodeck/daemon/config.json';
const DAEMON_UNINSTALL_COMMAND =
  '~/.octodeck/daemon/bin/octodeck-daemon uninstall';

/**
 * 支持的平台 + 架构组合。
 * 二进制存放路径：client/octodeck-daemon/dist/octodeck-daemon-{os}-{arch}
 *  - os:   darwin | linux
 *  - arch: amd64  | arm64
 */
const SUPPORTED_PLATFORMS: Record<string, string[]> = {
  darwin: ['amd64', 'arm64'],
  linux: ['amd64', 'arm64'],
};

/** GOOS/GOARCH 到文件名后缀的映射（与 Makefile build-daemon-all 保持一致）。 */
const GOOS_TO_UNAME_S: Record<string, string> = {
  darwin: 'Darwin',
  linux: 'Linux',
};
const GOARCH_TO_UNAME_M: Record<string, string> = {
  amd64: 'x86_64',
  arm64: 'arm64',
};

function normalizeGoos(raw: string): string {
  const key = raw.toLowerCase();
  if (SUPPORTED_PLATFORMS[key]) return key;
  // 接受 uname -s 风格的输入
  if (key === 'darwin' || key === 'macos' || key === 'mac' || key === 'osx') return 'darwin';
  if (key === 'linux') return 'linux';
  return '';
}

function normalizeGoarch(raw: string): string {
  const key = raw.toLowerCase();
  if (key === 'amd64' || key === 'x86_64' || key === 'x64') return 'amd64';
  if (key === 'arm64' || key === 'aarch64') return 'arm64';
  return '';
}

function daemonBinaryBasename(goos: string, goarch: string): string {
  return `octodeck-daemon-${goos}-${goarch}`;
}

/**
 * 解析 daemon 二进制文件的绝对路径。
 * 优先级：
 *   1) client/octodeck-daemon/dist/octodeck-daemon-{os}-{arch}    (多平台产物)
 *   2) client/octodeck-daemon/octodeck-daemon                       (当前机本地构建, 兼容旧路径)
 */
function resolveDaemonBinary(goos: string, goarch: string): string | null {
  const distDir = path.resolve(process.cwd(), 'client/octodeck-daemon/dist');
  const primary = path.join(distDir, daemonBinaryBasename(goos, goarch));
  // 保留无后缀的同平台别名（例如 octodeck-daemon-darwin-arm64 也可写作 darwin-arm64）
  if (SUPPORTED_PLATFORMS[goos]?.includes(goarch)) return primary;
  return null;
}

function legacyDaemonBinaryPath(): string {
  return path.resolve(process.cwd(), 'client/octodeck-daemon/octodeck-daemon');
}

interface DaemonInstallScriptOptions {
  deviceId: string;
  token: string;
  server: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildDaemonInstallScript(
  opts: DaemonInstallScriptOptions,
): string {
  const server = new URL(opts.server).origin;
  const configJson = JSON.stringify(
    {
      server,
      token: opts.token,
      linkId: opts.deviceId,
      allowedBinaries: [
        '/bin/sh',
        '/bin/bash',
        '/usr/bin/env',
        '/usr/bin/python3',
        '/usr/local/bin/node',
        '/opt/homebrew/bin/node',
        '/usr/local/bin/coco',
        '/opt/homebrew/bin/coco',
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
      ],
      version: DAEMON_VERSION,
      autoUpdate: true,
    },
    null,
    2,
  );

  return `#!/usr/bin/env bash
set -euo pipefail

SERVER=${shellQuote(server)}
LINK_ID=${shellQuote(opts.deviceId)}
TOKEN=${shellQuote(opts.token)}
OCTODECK_HOME="${'${HOME}'}/.octodeck"
INSTALL_DIR="${'${OCTODECK_HOME}'}/daemon"
WORKSPACE_DIR="${'${OCTODECK_HOME}'}/workspace"
TASK_DIR="${'${OCTODECK_HOME}'}/task"
REPOS_DIR="${'${OCTODECK_HOME}'}/repos"
SESSION_DIR="${'${OCTODECK_HOME}'}/session"
CACHE_DIR="${'${OCTODECK_HOME}'}/cache"
TMP_DIR="${'${OCTODECK_HOME}'}/tmp"
STATE_DIR="${'${OCTODECK_HOME}'}/state"
LEGACY_INSTALL_DIR="${'${HOME}'}/.hcagent"
LEGACY_OCTODECK_INSTALL_DIR="${'${HOME}'}/.octodeck-daemon"
CONFIG_FILE="${'${INSTALL_DIR}'}/config.json"
OS="$(uname -s)"
PLIST="${'${HOME}'}/Library/LaunchAgents/com.octodeck.octodeck-daemon.plist"
LEGACY_PLIST="${'${HOME}'}/Library/LaunchAgents/com.happyclaw.hcagent.plist"
SYSTEMD_DIR="${'${HOME}'}/.config/systemd/user"
SERVICE="${'${SYSTEMD_DIR}'}/octodeck-daemon.service"
OCTODECK_DAEMON_PATH="${'${HOME}'}/.local/bin:${'${HOME}'}/bin:${'${HOME}'}/.bun/bin:${'${HOME}'}/.npm-global/bin:${'${HOME}'}/.volta/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Applications/cmux.app/Contents/Resources/bin"

# 根据 uname 推导 Go 风格的 GOOS / GOARCH，用于拼接下载 URL
DETECT_OS=""
DETECT_ARCH=""
case "${'${OS}'}" in
  Darwin) DETECT_OS="darwin" ;;
  Linux)  DETECT_OS="linux"  ;;
  *)
    printf 'unsupported OS: %s\n' "${'${OS}'}" >&2
    exit 1
    ;;
esac
MACHINE="$(uname -m)"
case "${'${MACHINE}'}" in
  x86_64|amd64|x64)   DETECT_ARCH="amd64" ;;
  arm64|aarch64)      DETECT_ARCH="arm64" ;;
  *)
    printf 'unsupported architecture: %s\n' "${'${MACHINE}'}" >&2
    exit 1
    ;;
esac
BIN_URL="${'${SERVER}'}/api/daemon/octodeck-daemon-bin/${'${DETECT_OS}'}/${'${DETECT_ARCH}'}"

log() { printf '[octodeck-daemon-install] %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { printf 'missing required command: %s\n' "$1" >&2; exit 1; }; }

need curl

mkdir -p "${'${INSTALL_DIR}'}/bin" "${'${WORKSPACE_DIR}'}" "${'${TASK_DIR}'}" "${'${REPOS_DIR}'}" "${'${SESSION_DIR}'}" "${'${CACHE_DIR}'}/downloads" "${'${CACHE_DIR}'}/npm" "${'${CACHE_DIR}'}/models" "${'${TMP_DIR}'}/updates" "${'${TMP_DIR}'}/runs" "${'${TMP_DIR}'}/skills-install" "${'${STATE_DIR}'}/locks"

if [ "${'${OS}'}" = "Darwin" ]; then
  log "stopping existing octodeck-daemon launch agent if present"
  launchctl bootout "gui/$(id -u)/com.octodeck.octodeck-daemon" >/dev/null 2>&1 || true
  launchctl bootout "gui/$(id -u)" "${'${PLIST}'}" >/dev/null 2>&1 || true
  log "stopping legacy hcagent launch agent if present"
  launchctl bootout "gui/$(id -u)/com.happyclaw.hcagent" >/dev/null 2>&1 || true
  launchctl bootout "gui/$(id -u)" "${'${LEGACY_PLIST}'}" >/dev/null 2>&1 || true
  rm -f "${'${LEGACY_PLIST}'}"
elif command -v systemctl >/dev/null 2>&1; then
  log "stopping existing octodeck-daemon systemd service if present"
  systemctl --user stop octodeck-daemon.service >/dev/null 2>&1 || true
  log "stopping legacy hcagent systemd service if present"
  systemctl --user disable --now hcagent.service >/dev/null 2>&1 || true
  rm -f "${'${SYSTEMD_DIR}'}/hcagent.service"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
fi

rm -rf "${'${LEGACY_OCTODECK_INSTALL_DIR}'}"

log "detected platform ${'${DETECT_OS}'}/${'${DETECT_ARCH}'}"
log "downloading octodeck-daemon binary"
curl -fsSL "${'${BIN_URL}'}" -o "${'${INSTALL_DIR}'}/bin/octodeck-daemon"
chmod +x "${'${INSTALL_DIR}'}/bin/octodeck-daemon"

cat > "${'${CONFIG_FILE}'}" <<'JSON'
${configJson}
JSON
chmod 600 "${'${CONFIG_FILE}'}"

if [ "${'${OS}'}" = "Darwin" ]; then
  mkdir -p "$(dirname "${'${PLIST}'}")"
  cat > "${'${PLIST}'}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.octodeck.octodeck-daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${'${INSTALL_DIR}'}/bin/octodeck-daemon</string>
    <string>-config</string>
    <string>${'${CONFIG_FILE}'}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${'${OCTODECK_HOME}'}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${'${OCTODECK_DAEMON_PATH}'}</string>
    <key>OCTODECK_DAEMON_EXTRA_PATH</key><string>${'${OCTODECK_DAEMON_PATH}'}</string>
  </dict>
  <key>StandardOutPath</key><string>${'${INSTALL_DIR}'}/octodeck-daemon.log</string>
  <key>StandardErrorPath</key><string>${'${INSTALL_DIR}'}/octodeck-daemon.err.log</string>
</dict>
</plist>
PLIST
  launchctl bootstrap "gui/$(id -u)" "${'${PLIST}'}"
  launchctl kickstart -k "gui/$(id -u)/com.octodeck.octodeck-daemon" >/dev/null 2>&1 || true
  log "octodeck-daemon installed and started via launchctl"
elif command -v systemctl >/dev/null 2>&1; then
  mkdir -p "${'${SYSTEMD_DIR}'}"
  cat > "${'${SERVICE}'}" <<SERVICE
[Unit]
Description=OctoDeck Daemon

[Service]
WorkingDirectory=${'${OCTODECK_HOME}'}
Environment=PATH=${'${OCTODECK_DAEMON_PATH}'}
Environment=OCTODECK_DAEMON_EXTRA_PATH=${'${OCTODECK_DAEMON_PATH}'}
ExecStart=${'${INSTALL_DIR}'}/bin/octodeck-daemon -config ${'${CONFIG_FILE}'}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
SERVICE
  systemctl --user daemon-reload
  systemctl --user enable --now octodeck-daemon.service
  log "octodeck-daemon installed and started via systemd user service"
else
  log "no supported service manager found; starting octodeck-daemon in background"
  cd "${'${OCTODECK_HOME}'}"
  nohup "${'${INSTALL_DIR}'}/bin/octodeck-daemon" -config "${'${CONFIG_FILE}'}" >"${'${INSTALL_DIR}'}/octodeck-daemon.log" 2>"${'${INSTALL_DIR}'}/octodeck-daemon.err.log" &
fi

log "device ${'${LINK_ID}'} configured for ${'${SERVER}'}"
`;
}

export function buildDaemonUninstallScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail

OCTODECK_HOME="${'${HOME}'}/.octodeck"
INSTALL_DIR="${'${OCTODECK_HOME}'}/daemon"
BIN="${'${INSTALL_DIR}'}/bin/octodeck-daemon"
PLIST="${'${HOME}'}/Library/LaunchAgents/com.octodeck.octodeck-daemon.plist"
SYSTEMD_DIR="${'${HOME}'}/.config/systemd/user"
SERVICE="${'${SYSTEMD_DIR}'}/octodeck-daemon.service"

log() { printf '[octodeck-daemon-uninstall] %s\n' "$*"; }

if [ -x "${'${BIN}'}" ]; then
  log "running daemon built-in uninstall"
  "${'${BIN}'}" uninstall || true
else
  OS="$(uname -s)"
  if [ "${'${OS}'}" = "Darwin" ]; then
    log "stopping launchctl service"
    launchctl bootout "gui/$(id -u)/com.octodeck.octodeck-daemon" >/dev/null 2>&1 || true
    launchctl bootout "gui/$(id -u)" "${'${PLIST}'}" >/dev/null 2>&1 || true
    rm -f "${'${PLIST}'}"
  elif command -v systemctl >/dev/null 2>&1; then
    log "stopping systemd user service"
    systemctl --user disable --now octodeck-daemon.service >/dev/null 2>&1 || true
    rm -f "${'${SERVICE}'}"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  rm -rf "${'${INSTALL_DIR}'}"
fi

log "uninstalled. Workspace data under ${'${OCTODECK_HOME}'} is kept."
`;
}

const daemonRoutes = new Hono<{ Variables: Variables }>();

daemonRoutes.get('/version', (c) => {
  const server = new URL(c.req.url).origin;
  return c.json({
    version: DAEMON_VERSION,
    updateCommand: DAEMON_UPDATE_COMMAND,
    uninstallCommand: DAEMON_UNINSTALL_COMMAND,
    installCommand: `curl -fsSL "${server}/api/daemon/install-script?device=<DEVICE_ID>&apiKey=<TOKEN>&server=${encodeURIComponent(server)}" | bash`,
    supportedPlatforms: Object.entries(SUPPORTED_PLATFORMS).flatMap(([os, archs]) =>
      archs.map((arch) => ({ os, arch })),
    ),
  });
});

daemonRoutes.get('/uninstall-script', () => {
  return new Response(buildDaemonUninstallScript(), {
    status: 200,
    headers: {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
});

daemonRoutes.get('/install-script', (c) => {
  const deviceId = c.req.query('device') ?? c.req.query('linkId') ?? '';
  const token = c.req.query('apiKey') ?? c.req.query('token') ?? '';
  const server = c.req.query('server') ?? new URL(c.req.url).origin;

  if (!deviceId || !token) {
    return c.text('missing required query: device and apiKey\n', 400);
  }

  let script: string;
  try {
    script = buildDaemonInstallScript({ deviceId, token, server });
  } catch {
    return c.text('invalid server URL\n', 400);
  }

  return new Response(script, {
    status: 200,
    headers: {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
});

/**
 * 分平台下载：GET /api/daemon/octodeck-daemon-bin/:os/:arch
 * 支持 os   = darwin | linux
 *       arch = amd64  | arm64
 * 未命中时 404。
 */
daemonRoutes.get('/octodeck-daemon-bin/:os/:arch', async (c) => {
  const goos = normalizeGoos(c.req.param('os'));
  const goarch = normalizeGoarch(c.req.param('arch'));
  if (!goos || !goarch) {
    return c.text(
      `unsupported platform ${c.req.param('os')}/${c.req.param('arch')}; ` +
        `supported: darwin/amd64, darwin/arm64, linux/amd64, linux/arm64\n`,
      400,
    );
  }

  const distPath = resolveDaemonBinary(goos, goarch);
  let data: Buffer | undefined;
  let lastErr: unknown;
  if (distPath) {
    try {
      data = await readFile(distPath);
    } catch (err) {
      lastErr = err;
      // fallback 到 legacy 本地构建二进制（仅在同平台时才有意义）
      const hostGoos =
        process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : '';
      const hostGoarch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : '';
      if (hostGoos === goos && hostGoarch === goarch) {
        try {
          data = await readFile(legacyDaemonBinaryPath());
        } catch (err2) {
          lastErr = err2;
          data = undefined;
        }
      }
    }
  }
  if (!data) {
    return new Response(
      `octodeck-daemon binary for ${goos}/${goarch} not found. ` +
        `Build it first: make build-daemon-all (or build-daemon GOOS=${goos} GOARCH=${goarch}).\n` +
        (lastErr instanceof Error ? `error: ${lastErr.message}\n` : ''),
      {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      },
    );
  }

  const filename = daemonBinaryBasename(goos, goarch);
  return new Response(data, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
});

/**
 * 旧路由（向后兼容）。
 * 先尝试 ?os= &arch= 或 User-Agent 推断平台，否则返回当前主机构建的本地二进制。
 */
daemonRoutes.get('/octodeck-daemon-bin', async (c) => {
  const qsOs = normalizeGoos(c.req.query('os') ?? '');
  const qsArch = normalizeGoarch(c.req.query('arch') ?? '');
  if (qsOs && qsArch) {
    // 复用分平台实现：内部 307 重定向到带路径参数的 URL
    const server = new URL(c.req.url).origin;
    return c.redirect(
      `${server}/api/daemon/octodeck-daemon-bin/${qsOs}/${qsArch}`,
      307,
    );
  }

  // 未指定平台时使用本机构建的旧路径二进制，保持旧行为
  const binaryPath = legacyDaemonBinaryPath();
  let data: Buffer;
  try {
    data = await readFile(binaryPath);
  } catch {
    return new Response(
      'octodeck-daemon binary not found; build client/octodeck-daemon/octodeck-daemon first\n' +
        'hint: for cross-platform download use GET /api/daemon/octodeck-daemon-bin/:os/:arch\n',
      {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      },
    );
  }

  return new Response(data, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="octodeck-daemon"',
      'cache-control': 'no-store',
    },
  });
});

/**
 * GET /api/daemon/platforms
 * 返回支持的平台列表，供前端 UI 展示。
 */
daemonRoutes.get('/platforms', (c) => {
  return c.json({
    platforms: Object.entries(SUPPORTED_PLATFORMS).flatMap(([os, archs]) =>
      archs.map((arch) => ({
        os,
        arch,
        unameS: GOOS_TO_UNAME_S[os],
        unameM: GOARCH_TO_UNAME_M[arch],
        downloadUrl:
          new URL(c.req.url).origin +
          `/api/daemon/octodeck-daemon-bin/${os}/${arch}`,
      })),
    ),
  });
});

export default daemonRoutes;
