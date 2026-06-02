import { describe, expect, test } from 'vitest';

import { buildDaemonInstallScript } from '../src/routes/daemon.js';

describe('daemon install script', () => {
  test('embeds device credentials and installs octodeck-daemon from a binary download', () => {
    const script = buildDaemonInstallScript({
      deviceId: 'cl_1234567890abcdef',
      token: 'tok_secret',
      server: 'https://seedclaw.byted.org',
    });

    expect(script).toContain("SERVER='https://seedclaw.byted.org'");
    expect(script).toContain("LINK_ID='cl_1234567890abcdef'");
    expect(script).toContain("TOKEN='tok_secret'");
    expect(script).toContain('BIN_URL="${SERVER}/api/daemon/octodeck-daemon-bin"');
    const bootoutIndex = script.indexOf(
      'launchctl bootout "gui/$(id -u)/com.octodeck.octodeck-daemon"',
    );
    const downloadIndex = script.indexOf('curl -fsSL "${BIN_URL}" -o "${INSTALL_DIR}/bin/octodeck-daemon"');
    expect(bootoutIndex).toBeGreaterThanOrEqual(0);
    expect(downloadIndex).toBeGreaterThanOrEqual(0);
    expect(bootoutIndex).toBeLessThan(downloadIndex);
    expect(script).toContain('LEGACY_INSTALL_DIR="${HOME}/.hcagent"');
    expect(script).toContain('LEGACY_PLIST="${HOME}/Library/LaunchAgents/com.happyclaw.hcagent.plist"');
    expect(script).toContain('launchctl bootout "gui/$(id -u)/com.happyclaw.hcagent"');
    expect(script).toContain('rm -f "${LEGACY_PLIST}"');
    expect(script).toContain('systemctl --user disable --now hcagent.service');
    expect(script).toContain('rm -f "${SYSTEMD_DIR}/hcagent.service"');
    expect(script).toContain('curl -fsSL "${BIN_URL}" -o "${INSTALL_DIR}/bin/octodeck-daemon"');
    expect(script).toContain('chmod +x "${INSTALL_DIR}/bin/octodeck-daemon"');
    expect(script).toContain('"linkId": "cl_1234567890abcdef"');
    expect(script).toContain('launchctl bootstrap "gui/$(id -u)" "${PLIST}"');
    expect(script).toContain('launchctl kickstart -k "gui/$(id -u)/com.octodeck.octodeck-daemon"');
    expect(script).toContain('<key>EnvironmentVariables</key>');
    expect(script).toContain('<key>OCTODECK_DAEMON_EXTRA_PATH</key>');
    expect(script).toContain('/opt/homebrew/bin');
    expect(script).toContain('/Applications/cmux.app/Contents/Resources/bin');
    expect(script).toContain('systemctl --user enable --now octodeck-daemon.service');
    expect(script).toContain('Environment=OCTODECK_DAEMON_EXTRA_PATH=${OCTODECK_DAEMON_PATH}');
    expect(script).not.toContain('git clone');
    expect(script).not.toContain('go build');
    expect(script).not.toContain('launchctl load');
    expect(script).not.toContain('launchctl unload');
  });
});
