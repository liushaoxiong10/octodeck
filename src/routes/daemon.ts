import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Variables } from '../web-context.js';

const DAEMON_VERSION = 'octodeck-daemon/1.0.8';
const DAEMON_UPDATE_COMMAND =
  '~/.octodeck/daemon/bin/octodeck-daemon update -config ~/.octodeck/daemon/config.json';
const DAEMON_UNINSTALL_COMMAND =
  '~/.octodeck/daemon/bin/octodeck-daemon uninstall';

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
BIN_URL="${'${SERVER}'}/api/daemon/octodeck-daemon-bin"
OS="$(uname -s)"
PLIST="${'${HOME}'}/Library/LaunchAgents/com.octodeck.octodeck-daemon.plist"
LEGACY_PLIST="${'${HOME}'}/Library/LaunchAgents/com.happyclaw.hcagent.plist"
SYSTEMD_DIR="${'${HOME}'}/.config/systemd/user"
SERVICE="${'${SYSTEMD_DIR}'}/octodeck-daemon.service"
OCTODECK_DAEMON_PATH="${'${HOME}'}/.local/bin:${'${HOME}'}/bin:${'${HOME}'}/.bun/bin:${'${HOME}'}/.npm-global/bin:${'${HOME}'}/.volta/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Applications/cmux.app/Contents/Resources/bin"

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

daemonRoutes.get('/octodeck-daemon-bin', async () => {
  const binaryPath = path.resolve(
    process.cwd(),
    'client/octodeck-daemon/octodeck-daemon',
  );
  let data: Buffer;
  try {
    data = await readFile(binaryPath);
  } catch {
    return new Response(
      'octodeck-daemon binary not found; build client/octodeck-daemon/octodeck-daemon first\n',
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

daemonRoutes.get('/version', (c) => {
  const server = new URL(c.req.url).origin;
  return c.json({
    version: DAEMON_VERSION,
    updateCommand: DAEMON_UPDATE_COMMAND,
    uninstallCommand: DAEMON_UNINSTALL_COMMAND,
    installCommand: `curl -fsSL "${server}/api/daemon/install-script?device=<DEVICE_ID>&apiKey=<TOKEN>&server=${encodeURIComponent(server)}" | bash`,
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

export default daemonRoutes;
