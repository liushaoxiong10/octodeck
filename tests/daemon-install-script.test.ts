import { describe, expect, test } from 'vitest';

import { buildDaemonInstallScript } from '../src/routes/daemon.js';

describe('daemon install script', () => {
  test('embeds device credentials and installs hcagent from a binary download', () => {
    const script = buildDaemonInstallScript({
      deviceId: 'cl_1234567890abcdef',
      token: 'tok_secret',
      server: 'https://seedclaw.byted.org',
    });

    expect(script).toContain("SERVER='https://seedclaw.byted.org'");
    expect(script).toContain("LINK_ID='cl_1234567890abcdef'");
    expect(script).toContain("TOKEN='tok_secret'");
    expect(script).toContain('BIN_URL="${SERVER}/api/daemon/hcagent-bin"');
    const bootoutIndex = script.indexOf(
      'launchctl bootout "gui/$(id -u)/com.happyclaw.hcagent"',
    );
    const downloadIndex = script.indexOf('curl -fsSL "${BIN_URL}" -o "${INSTALL_DIR}/bin/hcagent"');
    expect(bootoutIndex).toBeGreaterThanOrEqual(0);
    expect(downloadIndex).toBeGreaterThanOrEqual(0);
    expect(bootoutIndex).toBeLessThan(downloadIndex);
    expect(script).toContain('curl -fsSL "${BIN_URL}" -o "${INSTALL_DIR}/bin/hcagent"');
    expect(script).toContain('chmod +x "${INSTALL_DIR}/bin/hcagent"');
    expect(script).toContain('"linkId": "cl_1234567890abcdef"');
    expect(script).toContain('launchctl bootstrap "gui/$(id -u)" "${PLIST}"');
    expect(script).toContain('launchctl kickstart -k "gui/$(id -u)/com.happyclaw.hcagent"');
    expect(script).toContain('<key>EnvironmentVariables</key>');
    expect(script).toContain('<key>HCAGENT_EXTRA_PATH</key>');
    expect(script).toContain('/opt/homebrew/bin');
    expect(script).toContain('/Applications/cmux.app/Contents/Resources/bin');
    expect(script).toContain('systemctl --user enable --now happyclaw-hcagent.service');
    expect(script).toContain('Environment=HCAGENT_EXTRA_PATH=${HCAGENT_PATH}');
    expect(script).not.toContain('git clone');
    expect(script).not.toContain('go build');
    expect(script).not.toContain('launchctl load');
    expect(script).not.toContain('launchctl unload');
  });
});
